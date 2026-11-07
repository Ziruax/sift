import { NextResponse } from "next/server";

// ── Bot price poll — the FreeCryptoAPI proxy ─────────────────────────────────
//
// This is the ONLY server-side dependency of the deployed app, and it exists
// for one reason: the FreeCryptoAPI key must never ship to the browser. The
// route is stateless (no database, no session, no cookies) so it runs
// anywhere — sandbox dev server or a serverless function — and it is called
// ONLY while the user has active investment bots with price ranges.
//
// Data path:
//   browser → POST /api/bot/poll { symbols } → FreeCryptoAPI getData (primary)
//                                            → Binance public REST (failover)
//
// FreeCryptoAPI charges 1 credit per returned symbol, so the client keeps the
// symbol list tight (active bots only) and paces itself. When the quota or
// the service is down we fail over to Binance's public ticker so a range hit
// is still caught and the notification still fires — reliability first.

export const dynamic = "force-dynamic";

// The user's key, used when no env var is configured (e.g. first deploy).
// Override on the host with FREECRYPTO_API_KEY to rotate it out of the repo.
const FALLBACK_KEY = "63h2btlm4vtoi06br4v7";
const API_BASE = "https://api.freecryptoapi.com/v1/getData";
const BINANCE_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

const MAX_SYMBOLS = 20;
const DEDUPE_MS = 2_000; // identical polls within 2s share one upstream call

type PriceInfo = {
  price: number;
  change24h: number | null;
  high24h: number | null;
  low24h: number | null;
  source: string | null; // exchange the row came from, when known
};

type PollResult = {
  ok: boolean;
  source: "freecryptoapi" | "binance";
  at: string;
  prices: Record<string, PriceInfo>;
  missing: string[];
  error?: string;
};

// Micro-cache: several UI surfaces can request the same symbols within one
// second (engine tick + an instant confirm). One upstream request serves all.
const cache = new Map<string, { at: number; value: PollResult }>();

function cleanSymbols(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    const clean = item.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (clean.length >= 2) seen.add(clean);
    if (seen.size >= MAX_SYMBOLS) break;
  }
  return [...seen];
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

async function fetchFreeCrypto(symbols: string[]): Promise<PollResult> {
  const key = process.env.FREECRYPTO_API_KEY || FALLBACK_KEY;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9_000);
  try {
    const response = await fetch(`${API_BASE}?symbol=${symbols.join("+")}`, {
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`FreeCryptoAPI responded ${response.status}`);
    const payload = (await response.json()) as {
      status?: unknown;
      symbols?: Array<{ symbol?: unknown; last?: unknown; lowest?: unknown; highest?: unknown; daily_change_percentage?: unknown; source_exchange?: unknown }>;
      error?: unknown;
    };
    if (payload.status !== "success" || !Array.isArray(payload.symbols)) {
      throw new Error(typeof payload.error === "string" ? payload.error : "FreeCryptoAPI returned no data");
    }
    const prices: Record<string, PriceInfo> = {};
    for (const row of payload.symbols) {
      const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
      const price = num(row.last);
      if (!symbol || !Number.isFinite(price) || price <= 0) continue;
      prices[symbol] = {
        price,
        change24h: Number.isFinite(num(row.daily_change_percentage)) ? num(row.daily_change_percentage) : null,
        high24h: Number.isFinite(num(row.highest)) ? num(row.highest) : null,
        low24h: Number.isFinite(num(row.lowest)) ? num(row.lowest) : null,
        source: typeof row.source_exchange === "string" ? row.source_exchange : null,
      };
    }
    return {
      ok: true,
      source: "freecryptoapi",
      at: new Date().toISOString(),
      prices,
      missing: symbols.filter((s) => !(s in prices)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBinance(symbols: string[]): Promise<PollResult> {
  const pairs = symbols.map((s) => `${s}USDT`);
  const query = `/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(pairs))}`;
  let lastError: unknown = null;
  for (const host of BINANCE_HOSTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);
    try {
      const response = await fetch(host + query, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Binance responded ${response.status}`);
      const payload = (await response.json()) as Array<{ symbol?: unknown; price?: unknown }>;
      if (!Array.isArray(payload)) throw new Error("Unexpected Binance payload");
      const prices: Record<string, PriceInfo> = {};
      for (const row of payload) {
        const pair = typeof row.symbol === "string" ? row.symbol.toUpperCase() : "";
        const price = num(row.price);
        const base = pair.replace(/USDT$/, "");
        if (base && Number.isFinite(price) && price > 0) {
          prices[base] = { price, change24h: null, high24h: null, low24h: null, source: "binance" };
        }
      }
      return {
        ok: true,
        source: "binance",
        at: new Date().toISOString(),
        prices,
        missing: symbols.filter((s) => !(s in prices)),
      };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error("Binance unreachable");
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const symbols = cleanSymbols((body as { symbols?: unknown } | null)?.symbols);
  if (symbols.length === 0) {
    return NextResponse.json({ ok: false, error: "No valid symbols requested." }, { status: 400 });
  }

  const cacheKey = symbols.join(",");
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < DEDUPE_MS) {
    return NextResponse.json(hit.value);
  }

  let result: PollResult;
  try {
    result = await fetchFreeCrypto(symbols);
  } catch (freeError) {
    // Failover: a quota wall or an outage must never silence the bots.
    try {
      result = await fetchBinance(symbols);
      result.error = `FreeCryptoAPI unavailable (${freeError instanceof Error ? freeError.message : "error"}) — using Binance public prices.`;
    } catch {
      return NextResponse.json(
        { ok: false, error: "Both price feeds are unreachable right now. Retrying is automatic." },
        { status: 502 },
      );
    }
  }

  cache.set(cacheKey, { at: Date.now(), value: result });
  if (cache.size > 40) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return NextResponse.json(result);
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'POST { symbols: ["BTC", …] } to poll bot prices.' },
    { status: 405 },
  );
}
