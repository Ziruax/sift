// CoinPaprika client — the board, search, saved coins and coin detail.
// Server-side only: one shared cache per server process, inflight dedup so a
// burst of users costs one upstream request, and stale-serve on failure.

import { fetchJson, friendlyError, num, numOrNull, text, TtlCache } from "./cache";
import type { BookKey, Board, Coin, CoinDetail, GlobalStats, WindowKey } from "./types";
import { changeOf } from "./format";

const TICKER_TTL = 45_000;
const TICKER_STALE = 10 * 60_000;
const GLOBAL_TTL = 60_000;
const GLOBAL_STALE = 30 * 60_000;
const COIN_TTL = 60_000;
const COIN_STALE = 24 * 60 * 60_000;

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

// ── Tickers (the full tape) ─────────────────────────────────────────────────

const tickerCache = new TtlCache<RawTicker[]>(TICKER_TTL, TICKER_STALE, async () => {
  // The full payload is ~1.7 MB — generous timeout, one retry on stall.
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
    throw friendlyError(error, "Live prices are unavailable right now.");
  }
}

export async function searchCoins(query: string): Promise<Coin[]> {
  const q = query.trim().toLowerCase().slice(0, 32);
  if (q.length < 1) return [];
  try {
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
  } catch (error) {
    throw friendlyError(error, "Search is unavailable right now.");
  }
}

export async function getSaved(ids: string[]): Promise<Coin[]> {
  const clean = ids.filter((id) => typeof id === "string" && /^[a-z0-9-]{2,80}$/.test(id)).slice(0, 60);
  if (clean.length === 0) return [];
  try {
    const { coins } = await loadCoins();
    const byId = new Map(coins.map((coin) => [coin.id, coin]));
    return clean.flatMap((id) => {
      const coin = byId.get(id);
      return coin ? [coin] : [];
    });
  } catch (error) {
    throw friendlyError(error, "Saved coins couldn't be refreshed.");
  }
}

// ── Coin detail ─────────────────────────────────────────────────────────────

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
    const friendly = friendlyError(error, "This coin couldn't be loaded.");
    if (error instanceof Error && (error.message.includes("404") || friendly.message.includes("tape"))) throw friendly;
    throw friendly;
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
    // Delegate to getCoin for full metadata (also fills the detail cache).
    return await getCoin(coin.id);
  } catch {
    return null;
  }
}
