// ── Shared scanner baseline math (V2.1 audit fixes) ──────────────────────────
//
// Pure functions shared by BOTH scanners (the browser engine in
// local-radar.ts and the server scanner in mini-services/radar/index.ts) so
// the two tiers compute the exact same numbers:
//
//   • the FIXED universe blacklist (audit §2.1 — the old suffix heuristics
//     silently killed JUP, BNB, SHIB, ARB…),
//   • the time-of-day, self-excluded volume baseline with a floor (audit §2.3),
//   • volume-anomaly universe ranking (audit §2.2),
//   • order-book analysis: walls, spread, depth-at-TP, wall AGE/persistence
//     (audit §2.5 / §3.2 / §4),
//   • beta / residual-momentum primitives (audit §3.4),
//   • CVD slope and trade-size skew (audit §4),
//   • listing age (audit §4).
//
// No side effects, no fetches — trivially testable and identical everywhere.

// ── Universe blacklist — exact matches only (audit §2.1) ─────────────────────
//
// The old rules ("base ends with UP/DOWN/BULL/BEAR", "3-6 char base ending in
// B") were substring heuristics that killed real tokens: JUP (Jupiter) ends
// with "UP"; BNB, SHIB, ARB, CKB, DGB end with "B". Binance's leveraged tokens
// are delisted, so suffix matching produced ONLY false negatives. What
// remains: exact stable/pegged/fiat sets, an exact leveraged-token list, and
// the digit+L/S leveraged pattern (BTC3L-style) which no legitimate Binance
// spot base matches.

export const STABLE_BASES = new Set([
  "USDT", "USDC", "FDUSD", "DAI", "TUSD", "USDP", "BUSD", "BFUSD", "USDS",
]);

export const FIAT_BASES = new Set([
  "EUR", "GBP", "BRL", "AUD", "TRY", "NGN", "UAH", "ARS", "MXN", "ZAR", "PLN", "CZK", "HUF", "ILS", "RON", "RUB", "JPY", "CNY",
]);

export const PEGGED_BASES = new Set([
  "RLUSD", "USD1", "USDE", "USD0", "PYUSD", "EURC", "USDD", "FRAX", "LUSD", "GUSD", "XUSD", "RWUSD", "XAUT", "PAXG", "EURI", "AEUR", "USDF",
]);

/** Delisted Binance leveraged tokens — kept as exact matches for safety. */
export const LEVERAGED_BASES = new Set([
  "BTCUP", "BTCDOWN", "ETHUP", "ETHDOWN", "BNBUP", "BNBDOWN", "ADAUP", "ADADOWN",
  "XRPUP", "XRPDOWN", "DOTUP", "DOTDOWN", "LINKUP", "LINKDOWN", "LTCUP", "LTCDOWN",
  "TRXUP", "TRXDOWN", "EOSUP", "EOSDOWN", "XLMUP", "XLMDOWN", "BCHUP", "BCHDOWN",
  "ETHBULL", "ETHBEAR", "BTCDOM",
]);

/** BTC3L / ADA2S style leveraged tokens (digit + L/S suffix). */
const LEVERAGED_PATTERN = /^[A-Z0-9]{1,10}[1-5](L|S)$/;

export function isJunkBase(base: string): boolean {
  if (!base) return true;
  // ASCII-alphanumeric only: Binance lists some CJK-symbol meme pairs
  // (币安人生USDT, 牛来USDT) that are real, but every downstream contract —
  // signal IDs, ingest validation, CoinPaprika lookup — is ASCII. They are
  // excluded honestly at the universe layer instead of crashing the log.
  if (!/^[A-Z0-9]{1,20}$/.test(base)) return true;
  return (
    STABLE_BASES.has(base) ||
    FIAT_BASES.has(base) ||
    PEGGED_BASES.has(base) ||
    LEVERAGED_BASES.has(base) ||
    LEVERAGED_PATTERN.test(base)
  );
}

// ── Volume baseline — time-of-day adjusted, self-excluded, floored (§2.3) ────

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export type BaselineResult = {
  /** Median 5m-block volume, time-of-day adjusted when possible, floored. */
  baseline: number;
  /** Usable blocks (excluding the self-exclusion window). */
  blocks: number;
  /** True when the anti-divide-by-zero floor raised the baseline. */
  floored: boolean;
};

/**
 * Baseline from 5-minute blocks over the prior 24h.
 *
 *   baseline = median(same-hour-of-day blocks)  when ≥ minSameHour samples
 *            else median(all blocks)
 *            then max(·, mean/20)                — new-listing floor
 *
 * `blocks` are the last 24h of CLOSED 5m blocks INCLUDING the spike window;
 * the last `excludeLast` blocks (default 6 = 30 min) are dropped so the spike
 * never dilutes its own baseline (self-exclusion, audit §2.3.1). Hour-of-day
 * buckets give the time-of-day control (§2.3.2) without any persistence.
 */
export function volumeBaseline(
  blocks: Array<{ t: number; qv: number }>, // oldest→newest, 5m open times in ms
  excludeLast = 6,
  minSameHour = 6,
): BaselineResult {
  const usable = blocks.slice(0, Math.max(0, blocks.length - excludeLast));
  if (usable.length === 0) return { baseline: 0, blocks: 0, floored: false };
  const refHour = hourOfDay(blocks[blocks.length - 1]?.t ?? 0);
  const sameHour = usable.filter((b) => hourOfDay(b.t) === refHour).map((b) => b.qv);
  const all = usable.map((b) => b.qv);
  const source = sameHour.length >= minSameHour ? sameHour : all;
  const med = median(source);
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  // Floor at 1/20 of the mean block: a freshly listed pair whose median is ~0
  // must not produce infinite rvol (audit §2.3). 20× is deliberately harsh —
  // it caps rvol at 20 for brand-new tapes, which is loud but finite.
  const floor = mean > 0 ? mean / 20 : 0;
  const baseline = Math.max(med, floor);
  return { baseline, blocks: usable.length, floored: baseline > med && med > 0 };
}

function hourOfDay(t: number): number {
  return Math.floor((Math.max(0, t) % 86_400_000) / 3_600_000);
}

/** Aggregate 1-minute buckets into 5m blocks (browser engine path). */
export function fiveMinuteBlocks(
  minutes: Array<{ minute: number; qv: number }>, // minute = epoch minute index
): Array<{ t: number; qv: number }> {
  const byBlock = new Map<number, number>();
  for (const m of minutes) {
    const block = Math.floor(m.minute / 5);
    byBlock.set(block, (byBlock.get(block) ?? 0) + m.qv);
  }
  return [...byBlock.entries()].sort((a, b) => a[0] - b[0]).map(([block, qv]) => ({ t: block * 300_000, qv }));
}

// ── Volume-anomaly universe ranking (audit §2.2) ─────────────────────────────

/**
 * anomaly = current 24h quote volume / median(7-day history of 24h volumes).
 * >1 means "money is arriving HERE, now" — the pump-detector's actual target,
 * unlike absolute volume which just finds big coins that can't move.
 * Returns 1 when there is not enough history yet (callers fall back to
 * absolute ranking and flag the pair as unranked).
 */
export function anomalyScore(current: number, history: number[]): number {
  const samples = history.filter((v) => Number.isFinite(v) && v > 0);
  if (samples.length < 2) return 1;
  const med = median(samples);
  if (med <= 0) return 1;
  // Clamp at 20 so a 3-day-old listing with a collapsing baseline can't ride
  // the top of the ranking forever.
  return Math.min(20, current / med);
}

// ── Order-book analysis (audit §2.5 / §3.2 / §4) ─────────────────────────────

export type BookSide = Array<[string, string]>; // [price, qty] as strings

export type DepthAnalysis = {
  askWall: { price: number; valueUsd: number } | null; // biggest ask in band
  bidWall: { price: number; valueUsd: number } | null; // biggest bid in band
  spreadBps: number | null;
  askDepthUsd: number; // total asks within +7% (the TP2 runway zone)
  bidDepthUsd: number; // total bids within −7%
  askWallToDepth: number | null; // ask wall / total asks in band (0..1)
  bidWallToDepth: number | null;
};

/**
 * Analyze a depth snapshot. `bandPct` is the wall scan band (±% of price);
 * the depth/runway zone is fixed at ±7% (beyond TP2 for every allowed stop).
 */
export function analyzeDepth(asks: BookSide, bids: BookSide, price: number, bandPct: number): DepthAnalysis {
  const out: DepthAnalysis = {
    askWall: null,
    bidWall: null,
    spreadBps: null,
    askDepthUsd: 0,
    bidDepthUsd: 0,
    askWallToDepth: null,
    bidWallToDepth: null,
  };
  if (price <= 0) return out;
  const bestAsk = asks.length > 0 ? Number(asks[0]?.[0]) : NaN;
  const bestBid = bids.length > 0 ? Number(bids[0]?.[0]) : NaN;
  if (Number.isFinite(bestAsk) && Number.isFinite(bestBid) && bestAsk > 0 && bestBid > 0) {
    out.spreadBps = ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000;
  }
  const lo = price * (1 - bandPct / 100);
  const hi = price * (1 + bandPct / 100);
  const runwayHi = price * 1.07;
  const runwayLo = price * 0.93;
  let askBandTotal = 0;
  let bidBandTotal = 0;
  for (const [rawPrice, rawQty] of asks) {
    const p = Number(rawPrice);
    const q = Number(rawQty);
    if (!Number.isFinite(p) || !Number.isFinite(q) || p <= price) continue;
    const usd = p * q;
    if (p <= runwayHi) out.askDepthUsd += usd;
    if (p <= hi) {
      askBandTotal += usd;
      if (!out.askWall || usd > out.askWall.valueUsd) out.askWall = { price: p, valueUsd: usd };
    }
  }
  for (const [rawPrice, rawQty] of bids) {
    const p = Number(rawPrice);
    const q = Number(rawQty);
    if (!Number.isFinite(p) || !Number.isFinite(q) || p >= price) continue;
    const usd = p * q;
    if (p >= runwayLo) out.bidDepthUsd += usd;
    if (p >= lo) {
      bidBandTotal += usd;
      if (!out.bidWall || usd > out.bidWall.valueUsd) out.bidWall = { price: p, valueUsd: usd };
    }
  }
  if (out.askWall && askBandTotal > 0) out.askWallToDepth = out.askWall.valueUsd / askBandTotal;
  if (out.bidWall && bidBandTotal > 0) out.bidWallToDepth = out.bidWall.valueUsd / bidBandTotal;
  return out;
}

// ── Wall persistence/age — a 5-second wall is probably spoofed (§4) ──────────

export type WallTrack = { price: number; valueUsd: number; firstSeenAt: number; lastSeenAt: number };

/**
 * Feed the latest wall into the persistence tracker; returns the age (sec) of
 * the tracked wall if the current wall is at (approximately) the same price,
 * else starts a new track (age 0). A wall that moved price is a NEW wall.
 */
export function trackWallAge(
  tracks: Map<string, WallTrack>,
  pair: string,
  wall: { price: number; valueUsd: number } | null,
  now = Date.now(),
  tolerance = 0.0005,
): number | null {
  if (wall === null) {
    tracks.delete(pair);
    return null;
  }
  const track = tracks.get(pair);
  if (track && Math.abs(track.price - wall.price) / wall.price <= tolerance) {
    track.lastSeenAt = now;
    track.valueUsd = wall.valueUsd;
    return Math.max(0, (now - track.firstSeenAt) / 1000);
  }
  tracks.set(pair, { price: wall.price, valueUsd: wall.valueUsd, firstSeenAt: now, lastSeenAt: now });
  return 0;
}

// ── Beta / residual momentum (audit §3.4) ────────────────────────────────────

/**
 * Rolling beta of coin returns on BTC returns from aligned close series
 * (oldest→newest, 1m or 5m bars — alignment by index). Clamped to [0.1, 3]
 * and returned null when the sample is too short or BTC variance ~ 0.
 */
export function betaFromCloses(coinCloses: number[], btcCloses: number[], minBars = 40): number | null {
  const n = Math.min(coinCloses.length, btcCloses.length);
  if (n < minBars) return null;
  const rc: number[] = [];
  const rb: number[] = [];
  for (let i = n - minBars; i < n; i += 1) {
    const pc = coinCloses[i - 1];
    const cc = coinCloses[i];
    const pb = btcCloses[i - 1];
    const cb = btcCloses[i];
    if (pc > 0 && pb > 0 && cc > 0 && cb > 0) {
      rc.push((cc - pc) / pc);
      rb.push((cb - pb) / pb);
    }
  }
  if (rc.length < minBars - 5) return null;
  const mc = rc.reduce((a, b) => a + b, 0) / rc.length;
  const mb = rb.reduce((a, b) => a + b, 0) / rb.length;
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < rc.length; i += 1) {
    cov += (rc[i] - mc) * (rb[i] - mb);
    varB += (rb[i] - mb) ** 2;
  }
  if (varB <= 1e-12) return null;
  return Math.min(3, Math.max(0.1, cov / varB));
}

// ── CVD slope + trade-size skew (audit §4) ───────────────────────────────────

/**
 * CVD slope over the last `count` bars: Σ(takerBuy − takerSell) / Σ(vol).
 * Range −1..1. Price up + negative slope = absorption/distribution — the
 * single best short-term warning in the free data set.
 */
export function cvdSlope(bars: Array<{ qv: number; tb: number }>, count = 3): number | null {
  const slice = bars.slice(-count);
  if (slice.length === 0) return null;
  let tbSum = 0;
  let volSum = 0;
  for (const b of slice) {
    tbSum += b.tb - (b.qv - b.tb);
    volSum += b.qv;
  }
  return volSum > 0 ? tbSum / volSum : null;
}

/** Average trade size now vs baseline median (both in USD per trade). */
export function sizeSpike(lastAvgSize: number, baselineMedianSize: number): number | null {
  if (!(baselineMedianSize > 0) || !(lastAvgSize >= 0)) return null;
  return lastAvgSize / baselineMedianSize;
}

// ── Listing age (audit §4) ───────────────────────────────────────────────────

export function listingAgeDays(firstCandleOpenMs: number | null | undefined, now = Date.now()): number | null {
  if (firstCandleOpenMs === null || firstCandleOpenMs === undefined || firstCandleOpenMs <= 0) return null;
  return Math.max(0, (now - firstCandleOpenMs) / 86_400_000);
}

// ── Ranked signal firing — uncapped score ordering (audit §2.5/§10) ─────────

/**
 * Sort rows so GO candidates fire in uncapped-score order before any per-scan
 * signal cap is applied. The old code cut at row order (base-score ranked),
 * which made go_long/go_short priority arbitrary.
 */
export function rankForSignalCut<T extends { score: number; pair: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.score - a.score || a.pair.localeCompare(b.pair));
}
