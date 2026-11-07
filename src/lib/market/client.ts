"use client";

// ── Client-side market data layer ─────────────────────────────────────────────
//
// Everything here runs IN THE BROWSER against CORS-open public APIs:
//
//   • CoinPaprika — board, search, saved coins, coin detail (per-user IP,
//     so no shared-server rate limits, no cold starts)
//   • Binance data API — price history (spot klines)
//   • DeFiLlama — history fallback for coins without a Binance pair
//   • alternative.me — the Fear & Greed index for the sentiment strip
//
// The same TTL cache + inflight dedup + stale-serve strategy as the server
// routes protects the browser from hammering anything. The old /api routes
// still exist and still work, but the UI no longer depends on them — which
// is what lets the whole terminal deploy as pure static hosting with only
// the FreeCryptoAPI bot-proxy left on the server.

import { fetchJson, num, numOrNull, text, TtlCache } from "./cache";
import type { BookKey, Board, Coin, CoinDetail, GlobalStats, HistoryResult, PricePoint, RangeKey, WindowKey } from "./types";
import { changeOf } from "./format";

// ── CoinPaprika: the full tape ────────────────────────────────────────────────

const TICKER_TTL = 45_000;
const TICKER_STALE = 10 * 60_000;
const GLOBAL_TTL = 60_000;
const GLOBAL_STALE = 30 * 60_000;
const COIN_TTL = 60_000;
const COIN_STALE = 24 * 60 * 60_000;
const FNG_TTL = 5 * 60_000;
const FNG_STALE = 24 * 60 * 60_000;

const BOOK_FLOOR: Record<BookKey, { volume: number; cap: number }> = {
  tradable: { volume: 500_000, cap: 20_000_000 },
  deep: { volume: 5_000_000, cap: 250_000_000 },
};

type RawQuote = {
  price?: unknown;
  volume_24h?: unknown;
  market_cap?: unknown;
  percent_change_15m?: unknown;
  percent_change_30m?: unknown;
  percent_change_1h?: unknown;
  percent_change_6h?: unknown;
  percent_change_24h?: unknown;
  percent_change_7d?: unknown;
  percent_change_30d?: unknown;
  percent_change_1y?: unknown;
  ath_price?: unknown;
  ath_date?: unknown;
  percent_from_price_ath?: unknown;
};

type RawTicker = {
  id?: unknown;
  name?: unknown;
  symbol?: unknown;
  rank?: unknown;
  total_supply?: unknown;
  max_supply?: unknown;
  circulating_supply?: unknown;
  quotes?: { USD?: RawQuote };
};

function toCoin(raw: RawTicker): Coin | null {
  const id = text(raw.id);
  const name = text(raw.name);
  const symbol = text(raw.symbol).toUpperCase();
  const quote = raw.quotes?.USD;
  if (!id || !name || !symbol || !quote) return null;
  const athDate = text(quote.ath_date);
  return {
    id,
    name,
    symbol,
    rank: num(raw.rank),
    price: num(quote.price),
    volume24h: num(quote.volume_24h),
    marketCap: num(quote.market_cap),
    change15m: num(quote.percent_change_15m),
    change30m: num(quote.percent_change_30m),
    change1h: num(quote.percent_change_1h),
    change6h: num(quote.percent_change_6h),
    change24h: num(quote.percent_change_24h),
    change7d: num(quote.percent_change_7d),
    change30d: num(quote.percent_change_30d),
    change1y: num(quote.percent_change_1y),
    athPrice: num(quote.ath_price),
    athDate: athDate || null,
    fromAth: num(quote.percent_from_price_ath),
    circulating: numOrNull(raw.circulating_supply),
    totalSupply: numOrNull(raw.total_supply),
    maxSupply: numOrNull(raw.max_supply),
  };
}

const tickerCache = new TtlCache<RawTicker[]>(TICKER_TTL, TICKER_STALE, async () => {
  const payload = await fetchJson("https://api.coinpaprika.com/v1/tickers?quotes=USD", 30_000, 1);
  if (!Array.isArray(payload)) throw new Error("Unexpected market payload");
  return payload as RawTicker[];
});

const globalCache = new TtlCache<GlobalStats>(GLOBAL_TTL, GLOBAL_STALE, async () => {
  const payload = (await fetchJson("https://api.coinpaprika.com/v1/global")) as {
    market_cap_usd?: unknown;
    volume_24h_usd?: unknown;
    bitcoin_dominance_percentage?: unknown;
    cryptocurrencies_number?: unknown;
    market_cap_change_24h?: unknown;
    volume_24h_change_24h?: unknown;
  };
  return {
    marketCap: num(payload.market_cap_usd),
    marketCapChange24h: num(payload.market_cap_change_24h),
    volume24h: num(payload.volume_24h_usd),
    volumeChange24h: num(payload.volume_24h_change_24h),
    btcDominance: num(payload.bitcoin_dominance_percentage),
    listed: num(payload.cryptocurrencies_number),
  };
});

const EMPTY_GLOBAL: GlobalStats = {
  marketCap: 0,
  marketCapChange24h: 0,
  volume24h: 0,
  volumeChange24h: 0,
  btcDominance: 0,
  listed: 0,
};

async function loadCoins(): Promise<{ coins: Coin[]; stale: boolean }> {
  const { value: rows, stale } = await tickerCache.get();
  const coins: Coin[] = [];
  for (const row of rows) {
    const coin = toCoin(row);
    if (coin && coin.price > 0) coins.push(coin);
  }
  return { coins, stale };
}

function movers(coins: Coin[], window: WindowKey, direction: "up" | "down", floor: { volume: number; cap: number }) {
  const sign = direction === "up" ? 1 : -1;
  const scored = coins
    .filter((coin) => coin.volume24h >= floor.volume && coin.marketCap >= floor.cap)
    .map((coin) => ({ coin, change: changeOf(coin, window) }))
    .filter((row) => row.change * sign > 0);
  scored.sort((a, b) => (b.change - a.change) * sign);
  const notable = scored.filter((row) => Math.abs(row.change) >= 0.15);
  const chosen = (notable.length > 0 ? notable : scored).slice(0, 40);
  return { coins: chosen.map((row) => row.coin), count: notable.length };
}

export function asWindow(value: unknown): WindowKey {
  return value === "30m" || value === "1h" ? value : "15m";
}

export function asBook(value: unknown): BookKey {
  return value === "deep" ? "deep" : "tradable";
}

export async function getBoard(input: { window?: string; book?: string }): Promise<Board> {
  const window = asWindow(input.window);
  const book = asBook(input.book);
  try {
    const [{ coins, stale }, globalRes] = await Promise.all([
      loadCoins(),
      globalCache.get().catch(() => null),
    ]);
    const global = globalRes?.value ?? EMPTY_GLOBAL;
    const floor = BOOK_FLOOR[book];
    const rising = movers(coins, window, "up", floor);
    const falling = movers(coins, window, "down", floor);
    const markets = [...coins].sort((a, b) => a.rank - b.rank || b.marketCap - a.marketCap).slice(0, 100);
    return {
      updatedAt: new Date().toISOString(),
      window,
      book,
      global,
      markets,
      rising: rising.coins,
      falling: falling.coins,
      risingCount: rising.count,
      fallingCount: falling.count,
      stale: stale || globalRes?.stale || undefined,
    };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("The price feed took too long to answer.");
    }
    throw new Error("Live prices are unavailable right now.");
  }
}

export async function searchCoins(query: string): Promise<Coin[]> {
  const q = query.trim().toLowerCase().slice(0, 32);
  if (q.length < 1) return [];
  const { coins } = await loadCoins();
  const matches = coins.filter(
    (coin) => coin.symbol.toLowerCase().includes(q) || coin.name.toLowerCase().includes(q),
  );
  matches.sort((a, b) => {
    const score = (coin: Coin) => {
      const symbol = coin.symbol.toLowerCase();
      if (symbol === q) return 0;
      if (symbol.startsWith(q)) return 1;
      if (coin.name.toLowerCase().startsWith(q)) return 2;
      return 3;
    };
    const diff = score(a) - score(b);
    return diff !== 0 ? diff : a.rank - b.rank;
  });
  return matches.slice(0, 20);
}

export async function getSaved(ids: string[]): Promise<Coin[]> {
  const clean = ids.filter((id) => typeof id === "string" && /^[a-z0-9-]{2,80}$/.test(id)).slice(0, 60);
  if (clean.length === 0) return [];
  const { coins } = await loadCoins();
  const byId = new Map(coins.map((coin) => [coin.id, coin]));
  return clean.flatMap((id) => {
    const coin = byId.get(id);
    return coin ? [coin] : [];
  });
}

// ── Coin detail ───────────────────────────────────────────────────────────────

function safeHttp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function firstLink(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const url = safeHttp(item);
    if (url) return url;
  }
  return null;
}

function tagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) tags.push(item.trim());
    else if (item && typeof item === "object" && "name" in item) {
      const name = text((item as { name?: unknown }).name).trim();
      if (name) tags.push(name);
    }
    if (tags.length >= 5) break;
  }
  return tags;
}

const detailCache = new Map<string, { at: number; value: CoinDetail }>();

function rememberDetail(key: string, value: CoinDetail) {
  if (detailCache.size > 80) {
    const oldest = detailCache.keys().next().value;
    if (oldest) detailCache.delete(oldest);
  }
  detailCache.set(key, { at: Date.now(), value });
}

export async function getCoin(id: string): Promise<CoinDetail> {
  if (!/^[a-z0-9-]{2,80}$/.test(id)) throw new Error("That coin id doesn't look right.");
  const cached = detailCache.get(id);
  if (cached && Date.now() - cached.at < COIN_TTL) return cached.value;
  try {
    const [tickerPayload, metaPayload] = await Promise.all([
      fetchJson(`https://api.coinpaprika.com/v1/tickers/${id}?quotes=USD`),
      fetchJson(`https://api.coinpaprika.com/v1/coins/${id}`).catch(() => null),
    ]);
    const coin = toCoin(tickerPayload as RawTicker);
    if (!coin) throw new Error("That coin isn't on the tape.");
    const meta = (metaPayload ?? {}) as {
      logo?: unknown;
      description?: unknown;
      started_at?: unknown;
      proof_type?: unknown;
      tags?: unknown;
      links?: { website?: unknown; explorer?: unknown };
      whitepaper?: { link?: unknown };
    };
    const description = text(meta.description).replace(/\s+/g, " ").trim().slice(0, 1400);
    const detail: CoinDetail = {
      coin,
      logo: safeHttp(meta.logo),
      description,
      startedAt: text(meta.started_at) || null,
      proof: text(meta.proof_type) || null,
      tags: tagsOf(meta.tags),
      website: firstLink(meta.links?.website),
      explorer: firstLink(meta.links?.explorer),
      whitepaper: safeHttp(meta.whitepaper?.link),
    };
    rememberDetail(id, detail);
    return detail;
  } catch (error) {
    if (cached && Date.now() - cached.at < COIN_STALE) return cached.value;
    if (error instanceof Error && error.message.includes("404")) throw new Error("That coin isn't on the tape.");
    throw new Error("This coin couldn't be loaded.");
  }
}

// Resolve by Binance pair base (e.g. PEPEUSDT → the CoinPaprika coin PEPE).
export async function lookupByPair(pair: string): Promise<CoinDetail | null> {
  const clean = pair.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  if (!clean.endsWith("USDT") || clean.length <= 4) return null;
  const base = clean.slice(0, -4);
  try {
    const { coins } = await loadCoins();
    const bySymbol = new Map(coins.map((coin) => [coin.symbol.toUpperCase(), coin]));
    const coin = bySymbol.get(base);
    if (!coin) return null;
    return await getCoin(coin.id);
  } catch {
    return null;
  }
}

// ── Price history (Binance → DeFiLlama; Yahoo is dropped client-side because
//    it blocks browser CORS) ──────────────────────────────────────────────────

const VISION = "https://data-api.binance.vision";

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

type HistoryEntry = { at: number; value: HistoryResult };
const historyMemo = new Map<string, HistoryEntry>();

function rememberHistory(key: string, value: HistoryResult) {
  if (historyMemo.size > 60) {
    const oldest = historyMemo.keys().next().value;
    if (oldest) historyMemo.delete(oldest);
  }
  historyMemo.set(key, { at: Date.now(), value });
}

export async function getHistory(input: { symbol?: string; range?: string; id?: string }): Promise<HistoryResult> {
  const symbol = cleanSymbol(input.symbol ?? "");
  const range = asRange(input.range);
  const slug = slugOf((input.id ?? "").toLowerCase());
  const key = `${symbol}|${slug}|${range}`;
  const cached = historyMemo.get(key);
  const ttl = range === "1d" || range === "7d" ? 90_000 : 10 * 60_000;
  if (cached && Date.now() - cached.at < ttl) return cached.value;

  let points = await binanceHistory(symbol, range);
  let source: HistoryResult["source"] = points.length >= 2 ? "binance" : "none";

  if (points.length < 2) {
    const fallback = await llamaHistory(slug, range);
    if (fallback.length >= 2) {
      points = fallback;
      source = "llama";
    }
  }

  const result: HistoryResult = { points, source };
  rememberHistory(key, result);
  return result;
}

// ── Fear & Greed index (alternative.me — free, CORS-open) ────────────────────

export type FearGreed = {
  value: number; // 0–100
  label: string; // "Fear", "Greed", …
  at: string; // ISO date of the reading
};

export type FearGreedSeries = {
  today: FearGreed;
  history: FearGreed[]; // newest first, up to 30 entries
};

const fngCache = new TtlCache<FearGreedSeries>(FNG_TTL, FNG_STALE, async () => {
  const payload = (await fetchJson("https://api.alternative.me/fng/?limit=30&format=json")) as {
    data?: Array<{ value?: unknown; value_classification?: unknown; timestamp?: unknown }>;
  };
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const parsed = rows.flatMap((row) => {
    const value = num(row.value, NaN);
    const label = text(row.value_classification);
    const ts = num(row.timestamp, NaN);
    if (!Number.isFinite(value) || !label || !Number.isFinite(ts)) return [];
    return [{ value, label, at: new Date(ts * 1000).toISOString() } satisfies FearGreed];
  });
  if (parsed.length === 0) throw new Error("Fear & Greed feed returned no data");
  return { today: parsed[0] as FearGreed, history: parsed };
});

export async function getFearGreed(): Promise<FearGreedSeries> {
  const { value } = await fngCache.get();
  return value;
}
