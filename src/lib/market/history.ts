// Price history: Binance spot klines first (real OHLC, reliable, keyless),
// DeFiLlama as the fallback for coins without a USDT pair, Yahoo Finance as a
// last-ditch. This reverses the original Sift order (Yahoo first) because
// Yahoo answers 429s from many networks — Binance's data API has no such
// trouble and serves actual candle data.

import { fetchJson, num } from "./cache";
import type { HistoryResult, PricePoint, RangeKey } from "./types";

const VISION = "https://data-api.binance.vision";

// interval + candle count per range (Binance caps at 1000 candles).
const BINANCE_SPEC: Record<RangeKey, { interval: string; limit: number }> = {
  "1d": { interval: "5m", limit: 288 },
  "7d": { interval: "30m", limit: 336 },
  "1m": { interval: "1h", limit: 720 },
  "3m": { interval: "4h", limit: 540 },
  "1y": { interval: "1d", limit: 365 },
  max: { interval: "1w", limit: 400 },
};

export function asRange(value: unknown): RangeKey {
  const ranges: RangeKey[] = ["1d", "7d", "1m", "3m", "1y", "max"];
  return ranges.includes(value as RangeKey) ? (value as RangeKey) : "1d";
}

export function cleanSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

function slugOf(id: string): string {
  const slug = id.split("-").slice(1).join("-").toLowerCase();
  return /^[a-z0-9-]{2,64}$/.test(slug) ? slug : "";
}

type Kline = [number, string, string, string, string, string, number, string, number, string, string, string];

async function binanceHistory(symbol: string, range: RangeKey): Promise<PricePoint[]> {
  const clean = cleanSymbol(symbol);
  if (!clean) return [];
  const spec = BINANCE_SPEC[range];
  try {
    const payload = await fetchJson(
      `${VISION}/api/v3/klines?symbol=${encodeURIComponent(clean + "USDT")}&interval=${spec.interval}&limit=${spec.limit}`,
      12_000,
      0,
    );
    if (!Array.isArray(payload)) return [];
    const points: PricePoint[] = [];
    for (const k of payload as Kline[]) {
      const t = Math.floor(num(k[0]) / 1000);
      const o = num(k[1]);
      const h = num(k[2]);
      const l = num(k[3]);
      const c = num(k[4]);
      if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(c) || c <= 0) continue;
      points.push({ t, o, h, l, c });
    }
    return points;
  } catch {
    return [];
  }
}

// ── DeFiLlama fallback ──────────────────────────────────────────────────────

type LlamaPayload = {
  coins?: Record<string, { prices?: Array<{ timestamp?: unknown; price?: unknown }> }>;
};

async function llamaChunk(slug: string, start: number, period: string, span: number): Promise<PricePoint[]> {
  const url =
    `https://coins.llama.fi/chart/coingecko:${encodeURIComponent(slug)}` +
    `?start=${start}&span=${span}&period=${period}&searchWidth=600`;
  try {
    const payload = (await fetchJson(url, 10_000, 0)) as LlamaPayload;
    const prices = payload.coins?.[`coingecko:${slug}`]?.prices ?? [];
    const points: PricePoint[] = [];
    for (const row of prices) {
      const t = num(row.timestamp, NaN);
      const price = num(row.price, NaN);
      if (!Number.isFinite(t) || !Number.isFinite(price)) continue;
      points.push({ t, o: price, h: price, l: price, c: price });
    }
    return points;
  } catch {
    return [];
  }
}

async function llamaHistory(slug: string, range: RangeKey): Promise<PricePoint[]> {
  if (!slug) return [];
  const now = Math.floor(Date.now() / 1000);
  if (range !== "max" && range !== "1y") {
    const spec =
      range === "1d"
        ? { period: "5m", span: 288, start: now - 86_400 }
        : range === "7d"
          ? { period: "1h", span: 168, start: now - 7 * 86_400 }
          : range === "1m"
            ? { period: "2h", span: 360, start: now - 30 * 86_400 }
            : { period: "1d", span: 100, start: now - 90 * 86_400 };
    return llamaChunk(slug, spec.start, spec.period, spec.span);
  }
  const spanDays = 450;
  const origin = range === "1y" ? now - 365 * 86_400 : 1_388_534_400;
  const starts: number[] = [];
  for (let cursor = origin; cursor < now && starts.length < 12; cursor += spanDays * 86_400) {
    starts.push(cursor);
  }
  const chunks = await Promise.all(starts.map((start) => llamaChunk(slug, start, "1d", spanDays)));
  const merged = new Map<number, PricePoint>();
  for (const chunk of chunks) {
    for (const point of chunk) merged.set(point.t, point);
  }
  return [...merged.values()].sort((a, b) => a.t - b.t);
}

// ── Yahoo last resort (often rate-limited; kept for exotic coverage) ───────

type YahooPayload = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null> }> };
    }>;
    error?: { description?: string } | null;
  };
};

const YAHOO_SPEC: Record<RangeKey, string> = {
  "1d": "5m",
  "7d": "30m",
  "1m": "1h",
  "3m": "1d",
  "1y": "1d",
  max: "1mo",
};

async function yahooHistory(symbol: string, range: RangeKey): Promise<PricePoint[]> {
  const clean = cleanSymbol(symbol);
  if (!clean) return [];
  const now = Math.floor(Date.now() / 1000);
  const seconds: Record<RangeKey, number> = {
    "1d": 86_400,
    "7d": 7 * 86_400,
    "1m": 30 * 86_400,
    "3m": 90 * 86_400,
    "1y": 365 * 86_400,
    max: 15 * 365 * 86_400,
  };
  const period1 = range === "max" ? 1_230_768_000 : now - seconds[range];
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}-USD` +
    `?period1=${period1}&period2=${now}&interval=${YAHOO_SPEC[range]}&includePrePost=false`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; SiftTerminal/2.0)" },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as YahooPayload;
    if (payload.chart?.error) return [];
    const result = payload.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const stamps = result?.timestamp;
    if (!quote || !stamps) return [];
    const points: PricePoint[] = [];
    for (let i = 0; i < stamps.length; i += 1) {
      const close = quote.close?.[i];
      const t = stamps[i];
      if (typeof t !== "number" || typeof close !== "number" || !Number.isFinite(close)) continue;
      const open = typeof quote.open?.[i] === "number" ? (quote.open?.[i] as number) : close;
      const high = typeof quote.high?.[i] === "number" ? (quote.high?.[i] as number) : close;
      const low = typeof quote.low?.[i] === "number" ? (quote.low?.[i] as number) : close;
      points.push({ t, o: open, h: high, l: low, c: close });
    }
    return points;
  } catch {
    return [];
  }
}

// ── Orchestration with per-key memo ─────────────────────────────────────────

type Entry = { at: number; value: HistoryResult };
const memo = new Map<string, Entry>();

function remember(key: string, value: HistoryResult) {
  if (memo.size > 60) {
    const oldest = memo.keys().next().value;
    if (oldest) memo.delete(oldest);
  }
  memo.set(key, { at: Date.now(), value });
}

export async function getHistory(input: { symbol?: string; range?: string; id?: string }): Promise<HistoryResult> {
  const symbol = cleanSymbol(input.symbol ?? "");
  const range = asRange(input.range);
  const slug = slugOf((input.id ?? "").toLowerCase());
  const key = `${symbol}|${slug}|${range}`;
  const cached = memo.get(key);
  const ttl = range === "1d" || range === "7d" ? 90_000 : 10 * 60_000;
  if (cached && Date.now() - cached.at < ttl) return cached.value;

  let points: PricePoint[] = [];
  let source: HistoryResult["source"] = "none";

  points = await binanceHistory(symbol, range);
  if (points.length >= 2) source = "binance";

  if (points.length < 2) {
    const fallback = await llamaHistory(slug, range);
    if (fallback.length >= 2) {
      points = fallback;
      source = "llama";
    }
  }

  if (points.length < 2) {
    const yahoo = await yahooHistory(symbol, range);
    if (yahoo.length >= 2) {
      points = yahoo;
      source = "yahoo";
    }
  }

  const result: HistoryResult = { points, source };
  remember(key, result);
  return result;
}
