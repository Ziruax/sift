// ── Sift V2.1 accuracy engine ─────────────────────────────────────────────────
//
// One shared brain, three consumers:
//   • the server-side scanner (mini-services/radar) — imports this via a
//     relative path,
//   • the in-browser engine (local-radar.ts) — imports it like any module,
//   • the backtest simulator (Backtest view) — replays history through the
//     exact same filters.
//
// V2.1 is the post-audit revision. The changes that matter:
//
//   1. VOLATILITY-NORMALIZED THRESHOLDS — momentum, day-extension and the BTC
//      regime are measured in ATR units, not raw %. One threshold set now
//      survives quiet coins, normal coins and violent coins without re-tuning.
//   2. BETA-ADJUSTED MOMENTUM — residual move (coin minus β×BTC) replaces raw
//      move where β is computable, so the engine stops rewarding plain beta.
//   3. THREE ORTHOGONAL AXES — participation (volume expansion), directional
//      pressure (residual momentum + flow), microstructure (book + candles)
//      replace the old additive pile that double-counted momentum. Near-
//      constant filters (free +15 "no wall", free +5 "many trades") are gone.
//   4. UNCAPPED INTERNAL SCORE — ranking and calibration use the raw composite;
//      only the display caps at 100.
//   5. WALL SCORING RELATIVE TO THE BOOK — wall vs one-sided taker flow, wall
//      persistence (age) to discount 5-second spoofs, depth-at-TP runway.
//   6. TRADE-PLAN GEOMETRY FIXED — stop = 1.3 × ATR clamped [0.6%, 2.5%]; the
//      2R / 3.5R structure now sits at a constant ~2.6 / 4.5 ATR on every
//      coin. Dollar risk is constant by construction via position sizing.
//   7. HONEST BACKTEST — fees + slippage on every trade, partial exit at TP1
//      with a breakeven runner, shadow log of every gate rejection, Wilson
//      95% CI on the win rate, and an explicit tuned-vs-untuned split.
//
// The contract with reality is unchanged: no filter set makes the market
// predictable. This engine refuses obviously fake setups, sizes risk to each
// coin's own noise, and shows the scenario map before the decision.

import type { RadarRow } from "./types";

// ── Tunables ─────────────────────────────────────────────────────────────────
//
// TUNED marks numbers derived from replaying real Binance history (see
// scripts/tune-v2.ts). ASSUMED marks numbers with a documented rationale but
// no validated derivation — treat them as the high-risk knobs. The full table
// with derivations lives in ALGORITHM.md §15.

export const V2 = {
  // Momentum — ATR-normalized: a GO needs residual 5m and 15m moves above
  // momentumAtrMult × the ATR of that window (floored so a dead-quiet coin
  // still needs a visible tick). TUNED (structure; multiplier ASSUMED 0.5).
  momentumAtrMult: 0.5, // × ATR of the window
  momentumFloorPct: 0.15, // absolute floor, %
  momentum1mRed: -0.1, // 1m rollover penalty trigger, %
  // Dollar-volume liquidity floors (absolute by design — these are liquidity
  // gates, not edge measurements). TUNED.
  volHighUsd: 100_000,
  volLowUsd: 50_000,
  // Liquidity floor in trade count. TUNED.
  tradesLow: 200,
  // Volume-expansion gate — rvol (self-excluded, time-of-day adjusted) must
  // clear this for a GO. TUNED.
  goMinRvol: 2,
  // Wall filter — walls are compared to ONE-SIDED taker flow (buy flow for
  // ask walls), not two-sided tape. ASSUMED (wall data has no history).
  wallVsTaker: 1, // wall USD > 1 × 5m taker-buy flow → unbreakable
  wallVsVol: 1, // fallback when taker flow unknown
  wallScanPct: 2, // scan band ±2% of price
  wallScanAtrMult: 1.5, // …or ±1.5 × 5m ATR, whichever the engine is given
  wallConfirmMs: 120_000, // price must hold above a broken wall 2 min. TUNED
  wallFreshSec: 60, // walls younger than this count half — spoof discount. ASSUMED
  // BTC regime — 15m move in BTC-ATR units (floored at the old ±0.3% when
  // BTC ATR is unknown). TUNED (structure; multiplier ASSUMED 0.5).
  btcAtrMult: 0.5,
  btcBull: 0.3, // fallback thresholds, %
  btcDump: -0.3,
  // Day-extension gate — |24h change| vs 3 × daily ATR, clamped to the old
  // hard bounds. TUNED (bounds), ASSUMED (multiplier).
  dayAtrMult: 3,
  goLongDayMin: -5, // hard bounds, %
  goLongDayMax: 8,
  goShortDayMin: -15,
  goShortDayMax: 5,
  // Verdict bars on the NEW 0-100 axis scale — set from the 90-day measured
  // calibration (see ALGORITHM.md §8.2): the composite's top band carries the
  // only near-breakeven expectancy, so the bar sits high and the expectancy
  // gate below does the precision work.
  goScore: 60, // TUNED (90d measurement)
  goScoreFlat: 67, // TUNED (goScore + 7)
  goScoreShortDump: 55, // TUNED
  watchScore: 47, // TUNED
  // ── The expectancy gate (audit §8: "fire only when P × R:R_net − (1−P) > 0") ──
  // A GO additionally requires the backtest-calibrated hit rate of its score
  // band to imply net expectancy ≥ minExpectancyR under the partial-exit
  // structure and real costs. With the shipped default calibration this
  // currently means GOs are RARE AND HONEST — the measured 90-day hit rates
  // sit below the floor, so the engine says "watch" with the numbers instead
  // of pretending. Running a backtest recalibrates the gate to the user's own
  // window; a kinder regime re-opens GOs automatically.
  minExpectancyR: 0.1, // TUNED structure / ASSUMED margin (audit suggested 0.15)
  // Hard gates for a GO (liquidity + participation + crowd, unchanged in kind).
  goMinBuyPctLong: 52,
  goMinBuyPctShort: 48,
  // Trap checks. TUNED.
  fakeBuyersPct: 85,
  fakeBuyersTrades: 200,
  sellersDumpingPct: 40,
  sellersDumpingVolUsd: 100_000,
  // Trade-plan geometry — stop tracks the coin's own noise; TPs are constant
  // multiples of the stop, so R:R is invariant across volatility regimes.
  stopAtrMult: 1.3, // × 1m ATR. ASSUMED (industry-standard noise band).
  stopMinPct: 0.8, // floor: below this, fees + noise eat the edge. TUNED (90d: −0.40R → −0.26R vs 0.6%)
  stopMaxPct: 2.5, // cap: beyond this the trade is unmanageable. TUNED
  tp1Mult: 2, // TP1 = 2R. TUNED
  tp2Mult: 3.5, // TP2 = 3.5R. TUNED
  partialTp1Fraction: 0.5, // half off at TP1. ASSUMED (standard practice)
  beAtR: 1, // stop → entry after +1R. ASSUMED
  timeStopMin: 120, // flat or reassess at 2h. TUNED
  equityRiskFraction: 0.005, // 0.5% of equity per trade. ASSUMED
  // Costs — round-trip taker fees (2 × 0.1%) + slippage estimate on alts.
  // Applied to every backtest trade AND to the live expectancy gate.
  backtestCostPct: 0.25, // % per round trip
  // Market-structure gates. ASSUMED.
  spreadMaxBps: 15, // wider book → can't exit at TP honestly
  listingMinAgeDays: 3, // newer listings: baselines meaningless
  historyMinBlocks: 20, // usable 5m baseline blocks before rvol is trusted
  // Futures positioning signals (provisional weights — see ALGORITHM.md).
  fundingCrowdedPct: 0.05, // funding above +0.05%/8h crowds longs → penalty
  fundingCrowdedShortPct: -0.05, // extreme negative funding crowds shorts
  oiRealChange: 0.3, // OI + price both up ≥0.3%/15m = real money → bonus
  // Cooldowns — the anti-flip-flop ledger. TUNED.
  longBlockAfterBearishMs: 60 * 60_000,
  longBlockAfterShortMs: 30 * 60_000,
  shortBlockAfterLongMs: 30 * 60_000,
  signalRepeatMs: 30 * 60_000,
  // Portfolio layer — live risk management (audit §5.2). ASSUMED.
  maxConcurrentSignals: 3,
  correlationMax: 0.7,
  killSwitchLossStreak: 5,
  killSwitchDayLossR: -6, // ≈ −3% equity at 0.5% risk per trade
} as const;

// ── Volatility normalization helpers ────────────────────────────────────────

/** ATR of an N-minute window estimated from the 1m ATR (√time random-walk
 *  scaling — the honest approximation, measured ≈ √5 = 2.236 between 1m/5m). */
export function atrWindow(atr1mPct: number | null | undefined, minutes: number): number | null {
  if (atr1mPct === null || atr1mPct === undefined || !Number.isFinite(atr1mPct) || atr1mPct <= 0) return null;
  return atr1mPct * Math.sqrt(minutes);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Momentum bar for a GO: max(floor, momentumAtrMult × window ATR), falling
 *  back to the legacy fixed bar when ATR is unknown. */
export function momentumBar(atr1mPct: number | null | undefined, minutes: number, fallback = 0.4): number {
  const w = atrWindow(atr1mPct, minutes);
  return Math.max(V2.momentumFloorPct, w !== null ? V2.momentumAtrMult * w : fallback);
}

/** Daily ATR band for the day-extension gate, clamped to the hard bounds. */
function dayBandPct(atr1mPct: number | null | undefined): number {
  const daily = atrWindow(atr1mPct, 1440);
  if (daily === null) return 5.5; // geometric mean of the old −5/+8 bounds
  return Math.min(15, Math.max(3, V2.dayAtrMult * daily));
}

// ── Stablecoin immunity (unchanged — one of the things the audit liked) ─────

export function stablecoinLike(price: number, change15m: number, change24h: number): boolean {
  if (price > 0.99 && price < 1.01 && Math.abs(change15m) <= 0.05 && Math.abs(change24h) <= 1) return true;
  return false;
}

// ── BTC market regime — now in BTC-ATR units ────────────────────────────────

export type BtcMode = "bull" | "flat" | "dump";

export function btcModeFor(btcChange15m: number | null | undefined, btcAtr15m?: number | null): BtcMode | null {
  if (typeof btcChange15m !== "number" || !Number.isFinite(btcChange15m)) return null;
  // Bar = 0.5 × BTC's own 15m ATR when known (a 2% ATR BTC needs a real move
  // to count as bull; a 0.1% ATR BTC flips on ticks) — floored at the old
  // ±0.3% absolute so the fallback is the legacy behavior.
  const atr = typeof btcAtr15m === "number" && Number.isFinite(btcAtr15m) && btcAtr15m > 0 ? btcAtr15m : null;
  const bar = Math.max(Math.abs(V2.btcDump), atr !== null ? V2.btcAtrMult * atr : Math.abs(V2.btcDump));
  if (btcChange15m > bar) return "bull";
  if (btcChange15m < -bar) return "dump";
  return "flat";
}

export const BTC_MODE_COPY: Record<BtcMode, { label: string; note: string; tone: "up" | "warn" | "down" }> = {
  bull: { label: "Bull mode", note: "BTC leading vs its own volatility — longs at the normal bar", tone: "up" },
  flat: { label: "Flat mode", note: "BTC drifting vs its own volatility — longs need the stricter bar", tone: "warn" },
  dump: { label: "Dump mode", note: "BTC dumping vs its own volatility — all longs blocked, shorts favoured", tone: "down" },
};

// ── ATR — each coin sets its own stop distance ───────────────────────────────

/** True range series from candle [high, low, close] triples. */
export function atrPctFromCandles(
  candles: Array<{ high: number; low: number; close: number }>,
  period = 14,
): number | null {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (!cur || !prev) return null;
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    sum += tr;
  }
  const atr = sum / period;
  const last = candles[candles.length - 1];
  if (!last || last.close <= 0) return null;
  return (atr / last.close) * 100;
}

// ── Trade plans — constant-R geometry with constant dollar risk ─────────────
//
// stopPct = clamp(1.3 × 1m-ATR, 0.6%, 2.5%). TP1 = 2 × stopPct, TP2 = 3.5 ×
// stopPct — so the profit targets always sit ~2.6 / ~4.5 ATR out regardless
// of the coin's noise. Position size = (equity × 0.5%) / stopPct makes the
// DOLLAR risk identical on every coin by construction.

export type TradePlan = {
  side: "long" | "short";
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  riskPct: number;
  tp1Pct: number;
  tp2Pct: number;
  riskReward1: number;
  riskReward2: number;
  atrPct: number | null;
  blocked: boolean;
  blockReason: string | null;
  // V2.1 additions (optional so old serialized plans keep loading).
  instrument?: "spot" | "futures";
  timeStopMin?: number;
  management?: string[];
};

/** Stop distance: 1.3 × ATR clamped to [stopMinPct, stopMaxPct]. */
export function stopDistancePct(atrPct: number | null | undefined): number {
  if (atrPct === null || atrPct === undefined || !Number.isFinite(atrPct) || atrPct <= 0) return 1.0;
  return Math.min(V2.stopMaxPct, Math.max(V2.stopMinPct, V2.stopAtrMult * atrPct));
}

/** @deprecated kept for compatibility — returns the clamped stop distance. */
export function clampRisk(atrPct: number | null, mult = V2.stopAtrMult, min = V2.stopMinPct, max = V2.stopMaxPct): number {
  if (atrPct === null || !Number.isFinite(atrPct) || atrPct <= 0) return min;
  return Math.min(max, Math.max(min, atrPct * mult));
}

export function buildTradePlan(
  side: "long" | "short",
  entry: number,
  atrPct: number | null,
  wall: { price: number; valueUsd: number } | null,
  vol5mUsd: number,
  extras?: {
    takerFlow5mUsd?: number | null; // one-sided eating rate (buy flow for asks)
    askDepthToTp2Usd?: number | null; // cumulative asks entry→TP2
  },
): TradePlan {
  const riskPct = stopDistancePct(atrPct);
  const tp1Pct = riskPct * V2.tp1Mult;
  const tp2Pct = riskPct * V2.tp2Mult;
  const dir = side === "long" ? 1 : -1;
  const plan: TradePlan = {
    side,
    entry,
    stop: entry * (1 - (dir * riskPct) / 100),
    tp1: entry * (1 + (dir * tp1Pct) / 100),
    tp2: entry * (1 + (dir * tp2Pct) / 100),
    riskPct,
    tp1Pct,
    tp2Pct,
    riskReward1: V2.tp1Mult,
    riskReward2: V2.tp2Mult,
    atrPct: atrPct ?? null,
    blocked: false,
    blockReason: null,
    instrument: side === "short" ? "futures" : "spot",
    timeStopMin: V2.timeStopMin,
    management: [
      `${Math.round(V2.partialTp1Fraction * 100)}% off at TP1 (+${tp1Pct.toFixed(1)}%)`,
      `stop → breakeven at +${riskPct.toFixed(1)}% (1R)`,
      `runner to TP2 (+${tp2Pct.toFixed(1)}%)`,
      `flat by ${V2.timeStopMin} min — time stop`,
    ],
  };
  // Wall invalidation: compare the wall to ONE-SIDED taker flow when known
  // (an ask wall is eaten by buy pressure, not by two-sided tape).
  const eatingRate = extras?.takerFlow5mUsd ?? vol5mUsd;
  const flowLabel = extras?.takerFlow5mUsd != null ? "taker flow" : "5m volume";
  if (wall && wall.price > 0 && wall.valueUsd > eatingRate * (extras?.takerFlow5mUsd != null ? V2.wallVsTaker : V2.wallVsVol)) {
    const inTheWay = side === "long" ? wall.price < plan.tp2 && wall.price > entry : wall.price > plan.tp2 && wall.price < entry;
    if (inTheWay) {
      plan.blocked = true;
      plan.blockReason = `Wall $${Math.round(wall.valueUsd / 1000)}K at ${wall.price.toPrecision(6)} sits inside the profit zone vs ${fmtUsd(eatingRate)} ${flowLabel} — the tape cannot eat it yet`;
    }
  }
  // Runway check: is there enough ask depth between entry and TP2 to actually
  // exit the runner there? (Only when the caller supplied book depth.)
  if (!plan.blocked && extras?.askDepthToTp2Usd != null && extras.askDepthToTp2Usd > 0) {
    const runwayRatio = extras.askDepthToTp2Usd / Math.max(1, eatingRate);
    if (runwayRatio < 1) {
      plan.blocked = true;
      plan.blockReason = `Only ${fmtUsd(extras.askDepthToTp2Usd)} of asks all the way to TP2 — thinner than 1 ${flowLabel} block; the exit does not exist`;
    }
  }
  return plan;
}

/** Dollar risk framing: "risk $5 → lose max $0.05". */
export function riskFrame(investmentUsd: number, plan: TradePlan): { maxLossUsd: number; tp1Usd: number; tp2Usd: number } {
  return {
    maxLossUsd: (investmentUsd * plan.riskPct) / 100,
    tp1Usd: (investmentUsd * plan.tp1Pct) / 100,
    tp2Usd: (investmentUsd * plan.tp2Pct) / 100,
  };
}

/** Constant-dollar-risk position sizing: position = (equity × risk%) / stop%.
 *  A 0.8%-stop coin gets a 2× bigger position than a 1.6%-stop coin so the
 *  loss when wrong is identical. */
export function suggestedPositionUsd(equityUsd: number, plan: TradePlan, riskFraction = V2.equityRiskFraction): number {
  if (plan.riskPct <= 0) return 0;
  return (equityUsd * riskFraction) / (plan.riskPct / 100);
}

// ── The V2 input contract ────────────────────────────────────────────────────

export type V2Wall = { price: number; valueUsd: number } | null;

export type V2Input = {
  base: string;
  price: number;
  change1m: number;
  change5m: number;
  change15m: number;
  change24h: number;
  vol5mUsd: number;
  rvol: number;
  trades5m: number;
  buyPct: number;
  baseScore: number;
  atrPct: number | null;
  askWall: V2Wall;
  bidWall: V2Wall;
  askWallKnown: boolean;
  wallBrokenConfirmed: boolean | null;
  btcChange15m: number | null;
  btcChange1h: number | null;
  isStablecoin: boolean;
  // ── V2.1 additions (all optional — callers upgrade incrementally) ──────
  tradeSpike?: number; // trades5m / baseline trades5m (default 1 = unknown)
  closeStrength?: number; // 0..1 close position in range (default 0.5)
  beta?: number | null; // rolling coin-vs-BTC beta (null = not computable)
  residChange5m?: number | null; // change5m − β × btcChange5m
  residChange15m?: number | null; // change15m − β × btcChange15m
  btcChange5m?: number | null; // needed to compute residuals internally
  btcAtr15m?: number | null; // BTC's own 15m ATR, % (regime in ATR units)
  spreadBps?: number | null; // top-of-book spread (null = unknown)
  wallAgeSec?: number | null; // persistence of the biggest wall
  wallToDepthRatio?: number | null; // wallUsd / total depth in band (0..1)
  askDepthToTp2Usd?: number | null; // cumulative asks entry→(entry×1.07)
  cvdSlope15m?: number | null; // Σ(takerBuy − takerSell) / Σvol over 15m (−1..1)
  avgTradeSizeSpike?: number | null; // avg trade size 5m vs baseline
  oiChange15m?: number | null; // futures open-interest change, % (15m)
  fundingRatePct?: number | null; // futures funding, % per 8h
  lsRatio?: number | null; // global long/short account ratio
  listingAgeDays?: number | null; // days since first Binance candle
  historyBlocks?: number | null; // usable 5m baseline blocks (rvol trust)
};

export type V2Check = {
  label: string;
  pass: boolean | null; // null = not applicable / no data
  note: string;
};

export type SideVerdict = "go" | "watch" | "skip" | "blocked_btc";

export type SideAssessment = {
  score: number; // UNCAPPED composite — ranking and calibration use this
  verdict: SideVerdict;
  checks: V2Check[];
  trade: TradePlan | null;
  warnings: string[];
  demoteGate: string | null; // first hard gate that demoted a would-be GO
  axes: { participation: number; directional: number; microstructure: number };
};

function fmtUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

// ── The three orthogonal axes ────────────────────────────────────────────────
//
// participation (0..40): rvol (25) + tradeSpike (10) + absolute dollars (5)
// directional   (0..35): residual momentum (20) + taker flow (10) + CVD (5)
// microstruct.  (0..25): range-weighted close strength (10) + wall quality (15)
// penalties: liquidity / spread / fake buyers / crowded funding / traps
//
// The old model double- and triple-counted momentum (base 25 + filter 15 +
// day gate). These axes are deliberately non-overlapping measurement families.

type AxisResult = {
  participation: number;
  directional: number;
  microstructure: number;
  checks: V2Check[];
  warnings: string[];
};

function participationAxis(input: V2Input): { pts: number; checks: V2Check[] } {
  const tradeSpike = input.tradeSpike ?? 1;
  const rvolPts = 25 * clamp01((input.rvol - 1) / 4);
  const tradePts = 10 * clamp01((tradeSpike - 1) / 4);
  const dollarPts = 5 * clamp01(input.vol5mUsd / 200_000);
  const checks: V2Check[] = [
    {
      label: "Participation",
      pass: input.rvol >= V2.goMinRvol,
      note: `${input.rvol.toFixed(2)}× volume, ${tradeSpike.toFixed(2)}× trades, ${fmtUsd(input.vol5mUsd)} in 5m → ${Math.round(rvolPts + tradePts + dollarPts)}/40`,
    },
  ];
  return { pts: rvolPts + tradePts + dollarPts, checks };
}

function directionalAxis(input: V2Input, dir: 1 | -1): { pts: number; checks: V2Check[]; momentumPass: boolean } {
  const atr5 = atrWindow(input.atrPct, 5);
  const atr15 = atrWindow(input.atrPct, 15);
  const bar5 = momentumBar(input.atrPct, 5);
  const bar15 = momentumBar(input.atrPct, 15);
  // Residual momentum when beta is known; raw move otherwise.
  const hasResid = typeof input.residChange5m === "number" && Number.isFinite(input.residChange5m as number);
  const eff5 = (hasResid ? (input.residChange5m as number) : input.change5m) * dir;
  const eff15 = (hasResid ? (input.residChange15m ?? input.change15m) : input.change15m) * dir;
  const resid5Pts = 12 * clamp01(eff5 / bar5);
  const resid15Pts = 8 * clamp01(eff15 / bar15);
  const flowPts = 10 * clamp01(((input.buyPct - 50) * dir) / 25);
  const cvd = input.cvdSlope15m ?? null;
  const cvdPts = cvd !== null ? 5 * clamp01((cvd * dir + 0.15) / 0.5) : 0;
  const momentumPass = eff5 > bar5 && eff15 > bar15;
  const momentumNote = hasResid
    ? `residual 5m ${eff5 >= 0 ? "+" : ""}${eff5.toFixed(2)}% / 15m ${eff15 >= 0 ? "+" : ""}${eff15.toFixed(2)}% (β ${input.beta?.toFixed(2) ?? "?"}) vs bars ${bar5.toFixed(2)}%/${bar15.toFixed(2)}%`
    : `5m ${eff5.toFixed(2)}% / 15m ${eff15.toFixed(2)}% vs ATR bars ${bar5.toFixed(2)}%/${bar15.toFixed(2)}%`;
  const checks: V2Check[] = [
    {
      label: dir === 1 ? "Momentum (residual)" : "Momentum (residual)",
      pass: momentumPass,
      note: `${momentumNote} → ${Math.round(resid5Pts + resid15Pts)}/20`,
    },
    {
      label: "Taker flow",
      pass: dir === 1 ? input.buyPct >= V2.goMinBuyPctLong : input.buyPct <= V2.goMinBuyPctShort,
      note: `${input.buyPct.toFixed(0)}% buys of tape → ${Math.round(flowPts)}/10`,
    },
  ];
  if (cvd !== null) {
    const agrees = cvd * dir > 0;
    checks.push({
      label: "CVD slope",
      pass: agrees ? true : cvd * dir < -0.1 ? false : null,
      note: `${(cvd * 100).toFixed(0)}% net-taker ${cvd > 0 ? "buy" : "sell"} over 15m ${agrees ? "— confirms" : cvd * dir < -0.1 ? "— diverges from price: absorption" : "— neutral"} → ${Math.round(cvdPts)}/5`,
    });
    if (dir === 1 && input.change15m > 0 && cvd < -0.1) {
      // price up while cumulative delta falls = distribution into strength
      checks[checks.length - 1] = { ...checks[checks.length - 1], pass: false };
    }
    if (dir === -1 && input.change15m < 0 && cvd > 0.1) {
      checks[checks.length - 1] = { ...checks[checks.length - 1], pass: false };
    }
  }
  const atrHint = atr5 !== null ? ` (ATR5 ${atr5.toFixed(2)}%)` : "";
  if (atrHint) checks[0].note += atrHint;
  return { pts: resid5Pts + resid15Pts + flowPts + cvdPts, checks, momentumPass };
}

function microstructureAxis(input: V2Input, dir: 1 | -1): { pts: number; checks: V2Check[]; wallUnbreakable: boolean; wallFresh: boolean } {
  const atr5 = atrWindow(input.atrPct, 5);
  // Close strength, range-weighted: a tight doji contributes almost nothing,
  // a wide impulse candle counts fully (audit §4 closeStrength fix).
  const strength = input.closeStrength ?? 0.5;
  const closePts = 10 * clamp01(strength * dir);
  const checks: V2Check[] = [
    {
      label: "Close strength",
      pass: strength * dir > 0.55 ? true : strength * dir < 0.45 ? false : null,
      note: `closes ${(strength * 100).toFixed(0)}% up the 5m ranges → ${Math.round(closePts)}/10`,
    },
  ];

  // Wall quality — RELATIVE scoring. The old model gave a free +15 for "no
  // wall within 2%", which was almost always true and carried no information.
  // Now: no wall or broken wall earns a modest +8/+10; an unbreakable wall
  // (vs one-sided taker flow) costs −15; a wall that appeared seconds ago is
  // discounted as a probable spoof (half penalty) until it persists a minute.
  let wallPts = 0;
  let wallUnbreakable = false;
  let wallFresh = false;
  const wall = dir === 1 ? input.askWall : input.bidWall;
  const known = input.askWallKnown;
  const takerFlow = dir === 1 ? input.vol5mUsd * (input.buyPct / 100) : input.vol5mUsd * (1 - input.buyPct / 100);
  if (known && wall === null) {
    wallPts += 8;
    checks.push({ label: dir === 1 ? "Sell wall" : "Bid wall", pass: true, note: `no wall within band — modest runway +8` });
  } else if (known && wall !== null) {
    const above = dir === 1 ? input.price > wall.price : input.price < wall.price;
    if (above) {
      wallPts += 10;
      checks.push({
        label: dir === 1 ? "Sell wall" : "Bid wall",
        pass: true,
        note: `price beyond the ${fmtUsd(wall.valueUsd)} wall at ${wall.price.toPrecision(6)} +10`,
      });
    } else {
      const age = input.wallAgeSec ?? null;
      const persistent = age !== null && age >= V2.wallFreshSec;
      wallFresh = age !== null && age < V2.wallFreshSec;
      const unbreakable = wall.valueUsd > takerFlow * V2.wallVsTaker;
      wallUnbreakable = unbreakable && persistent;
      if (unbreakable && persistent) {
        wallPts -= 15;
        checks.push({
          label: dir === 1 ? "Sell wall" : "Bid wall",
          pass: false,
          note: `wall ${fmtUsd(wall.valueUsd)} vs ${fmtUsd(takerFlow)} ${dir === 1 ? "taker-buy" : "taker-sell"} flow, aged ${Math.round(age ?? 0)}s — cannot break −15`,
        });
      } else if (unbreakable && wallFresh) {
        wallPts -= 7;
        checks.push({
          label: dir === 1 ? "Sell wall" : "Bid wall",
          pass: null,
          note: `wall ${fmtUsd(wall.valueUsd)} vs ${fmtUsd(takerFlow)} flow but only ${Math.round(age ?? 0)}s old — half weight, possible spoof −7`,
        });
      } else {
        const depthRatio = input.wallToDepthRatio ?? null;
        checks.push({
          label: dir === 1 ? "Sell wall" : "Bid wall",
          pass: null,
          note: `wall ${fmtUsd(wall.valueUsd)}, eatable vs ${fmtUsd(takerFlow)} flow${depthRatio !== null ? `, ${(depthRatio * 100).toFixed(0)}% of book depth` : ""}`,
        });
      }
    }
  } else {
    checks.push({ label: dir === 1 ? "Sell wall" : "Bid wall", pass: null, note: "order book not fetched yet — no wall data" });
  }
  void atr5;
  return { pts: closePts + wallPts, checks, wallUnbreakable, wallFresh };
}

function penalties(input: V2Input, dir: 1 | -1): { pts: number; warnings: string[]; checks: V2Check[] } {
  let pts = 0;
  const warnings: string[] = [];
  const checks: V2Check[] = [];
  if (input.trades5m < V2.tradesLow) {
    pts -= 20;
    checks.push({ label: "Liquidity", pass: false, note: `${input.trades5m} trades in 5m — too thin −20` });
  } else {
    checks.push({ label: "Liquidity", pass: true, note: `${input.trades5m} trades in 5m — real participation` });
  }
  const spread = input.spreadBps ?? null;
  if (spread !== null) {
    if (spread > V2.spreadMaxBps) {
      pts -= 10;
      checks.push({ label: "Spread", pass: false, note: `${spread.toFixed(1)} bps top-of-book — exits pay the spread −10` });
    } else {
      checks.push({ label: "Spread", pass: true, note: `${spread.toFixed(1)} bps — tight enough to exit honestly` });
    }
  }
  // Fake-buyer trap (kept from V2 — a documented real failure mode).
  if (input.buyPct > V2.fakeBuyersPct && input.trades5m < V2.fakeBuyersTrades) {
    pts -= 15;
    warnings.push(`Fake buyers — ${input.buyPct.toFixed(0)}% buys on only ${input.trades5m} trades`);
    checks.push({ label: "Buyer trap", pass: false, note: `${input.buyPct.toFixed(0)}% buys on ${input.trades5m} trades — whale painting tape −15` });
  }
  // Sellers dumping (long side only).
  if (dir === 1 && input.buyPct < V2.sellersDumpingPct && input.vol5mUsd > V2.sellersDumpingVolUsd) {
    warnings.push("Sellers dumping — exit / avoid");
  }
  // Whale-print trap: few trades of unusual size (trade-size skew).
  const sizeSpike = input.avgTradeSizeSpike ?? null;
  if (sizeSpike !== null && sizeSpike >= 3 && input.trades5m < V2.tradesLow * 2) {
    pts -= 10;
    warnings.push(`Whale prints — avg trade ${sizeSpike.toFixed(1)}× normal on thin count`);
    checks.push({ label: "Trade size", pass: false, note: `avg trade ${sizeSpike.toFixed(1)}× baseline on ${input.trades5m} trades — one whale, not a crowd −10` });
  } else if (sizeSpike !== null && sizeSpike < 3) {
    checks.push({ label: "Trade size", pass: null, note: `avg trade ${sizeSpike.toFixed(1)}× baseline — crowd-sized prints` });
  }
  // Crowded funding (futures positioning) — provisional weights.
  const funding = input.fundingRatePct ?? null;
  if (funding !== null) {
    const crowdedLong = funding > V2.fundingCrowdedPct;
    const crowdedShort = funding < V2.fundingCrowdedShortPct;
    if (dir === 1 && crowdedLong) {
      pts -= 10;
      checks.push({ label: "Funding", pass: false, note: `funding +${funding.toFixed(3)}%/8h — longs crowded, squeeze-prone −10` });
    } else if (dir === -1 && crowdedShort) {
      pts -= 10;
      checks.push({ label: "Funding", pass: false, note: `funding ${funding.toFixed(3)}%/8h — shorts crowded, squeeze-prone −10` });
    } else {
      checks.push({ label: "Funding", pass: null, note: `funding ${funding.toFixed(3)}%/8h — not crowded` });
    }
  }
  // OI confirmation: OI + price both rising = new money (real); falling OI on
  // a rising tape = short squeeze (exhausts fast).
  const oi = input.oiChange15m ?? null;
  if (oi !== null && dir === 1) {
    if (oi >= V2.oiRealChange && input.change15m > 0) {
      pts += 5;
      checks.push({ label: "Open interest", pass: true, note: `OI +${oi.toFixed(2)}% with price up — new money arriving +5` });
    } else if (oi < 0 && input.change15m > 0) {
      pts -= 5;
      checks.push({ label: "Open interest", pass: false, note: `OI ${oi.toFixed(2)}% while price rises — short squeeze, exhausts fast −5` });
    } else {
      checks.push({ label: "Open interest", pass: null, note: `OI ${oi.toFixed(2)}% / 15m` });
    }
  }
  // Long/short account ratio — retail crowding fades.
  const ls = input.lsRatio ?? null;
  if (ls !== null) {
    if (dir === 1 && ls > 3) {
      pts -= 5;
      checks.push({ label: "L/S ratio", pass: false, note: `long/short accounts ${ls.toFixed(1)} — retail heavily long −5` });
    } else if (dir === -1 && ls < 0.5) {
      pts -= 5;
      checks.push({ label: "L/S ratio", pass: false, note: `long/short accounts ${ls.toFixed(1)} — retail heavily short −5` });
    } else {
      checks.push({ label: "L/S ratio", pass: null, note: `long/short accounts ${ls.toFixed(1)}` });
    }
  }
  return { pts, warnings, checks };
}

function axisResult(input: V2Input, dir: 1 | -1): AxisResult & { momentumPass: boolean; wallUnbreakable: boolean } {
  const part = participationAxis(input);
  const dirRes = directionalAxis(input, dir);
  const micro = microstructureAxis(input, dir);
  const pen = penalties(input, dir);
  return {
    participation: part.pts,
    directional: dirRes.pts,
    microstructure: micro.pts + pen.pts,
    checks: [...part.checks, ...dirRes.checks, ...micro.checks, ...pen.checks],
    warnings: pen.warnings,
    momentumPass: dirRes.momentumPass,
    wallUnbreakable: micro.wallUnbreakable,
  };
}

/** LONG side — three-axis composite + hard gates. `cal` is the caller's
 *  (the user's own backtest) calibration; the shipped measured default stands
 *  in otherwise. `opts.replay` disables the expectancy gate — the backtest is
 *  the calibration instrument and must measure the raw signal without the
 *  meta-gate, or it could never recalibrate the live one. */
export function assessLong(input: V2Input, cal?: Calibration | null, opts?: { replay?: boolean }): SideAssessment {
  const axes = axisResult(input, 1);
  const score = axes.participation + axes.directional + axes.microstructure;
  const mode = btcModeFor(input.btcChange15m, input.btcAtr15m);
  const threshold = mode === "flat" ? V2.goScoreFlat : V2.goScore;

  let verdict: SideVerdict;
  if (mode === "dump") {
    verdict = "blocked_btc";
    axes.checks.push({ label: "BTC regime", pass: false, note: `BTC 15m ${input.btcChange15m?.toFixed(2)}% vs its ATR — dumping, longs blocked` });
  } else {
    axes.checks.push({
      label: "BTC regime",
      pass: true,
      note:
        mode === "bull"
          ? `BTC 15m ${input.btcChange15m?.toFixed(2)}% vs its ATR — bull mode, bar ${threshold}`
          : `BTC 15m ${input.btcChange15m?.toFixed(2)}% vs its ATR — flat, needs ${threshold}+`,
    });
    if (score >= threshold) verdict = "go";
    else if (score >= V2.watchScore) verdict = "watch";
    else verdict = "skip";
  }

  if (input.isStablecoin) axes.checks.push({ label: "Stablecoin", pass: false, note: "pegged asset — can never pump, veto" });

  const trade = buildTradePlan(
    "long",
    input.price,
    input.atrPct,
    input.askWallKnown ? input.askWall : null,
    input.vol5mUsd,
    { takerFlow5mUsd: input.vol5mUsd * (input.buyPct / 100), askDepthToTp2Usd: input.askDepthToTp2Usd ?? null },
  );

  // ── Hard gates: a GO is not just a number (audit §8 kept the veto layer) ──
  let demoteGate: string | null = null;
  if (verdict === "go") {
    const gates: Array<[boolean, string, string]> = [];
    // THE EXPECTANCY GATE (audit §8: "fire only when P × R:R_net − (1−P) > 0"):
    // the calibrated hit rate of this score band must imply net expectancy ≥
    // minExpectancyR under the partial-exit structure and real costs. This is
    // the gate that keeps the engine honest when the measured regime can't
    // pay for the trade — it says "watch" with the numbers instead of "go".
    // Skipped in replay (the backtest IS the calibration instrument).
    if (!opts?.replay) {
      const calP = lookupHitRate(cal ?? DEFAULT_CALIBRATION, score);
      if (calP !== null) {
        const estR = expectancyEstimateR(calP.p, trade?.riskPct ?? 1);
        gates.push([
          estR >= V2.minExpectancyR,
          "expectancy",
          `Calibrated hit rate ${(calP.p * 100).toFixed(0)}% (n=${calP.n}) → est. ${estR >= 0 ? "+" : ""}${estR.toFixed(2)}R per trade — below the +${V2.minExpectancyR}R GO floor; a backtest on a kinder window re-opens this`,
        ]);
      }
    }
    // Listing age: new listings have meaningless baselines.
    const age = input.listingAgeDays ?? null;
    gates.push([
      age === null || age >= V2.listingMinAgeDays,
      "listing",
      age !== null ? `Listed ${age.toFixed(1)} days ago — ATR/rvol baselines unreliable, wait` : "",
    ]);
    // Baseline trust: rvol needs ≥ 20 usable baseline blocks.
    const blocks = input.historyBlocks ?? null;
    gates.push([
      blocks === null || blocks >= V2.historyMinBlocks,
      "history",
      blocks !== null ? `Only ${blocks} baseline blocks — volume baseline not trusted yet` : "",
    ]);
    // Momentum in ATR units (residual when beta known).
    gates.push([axes.momentumPass, "momentum", `Residual move under the ATR bar — drift, not impulse`]);
    // Day extension in ATR units, clamped by the hard bounds.
    const band = dayBandPct(input.atrPct);
    const dayMax = Math.min(V2.goLongDayMax, Math.max(3, band));
    const dayMin = -Math.min(15, Math.max(Math.abs(V2.goLongDayMin), band));
    gates.push([
      input.change24h >= dayMin && input.change24h <= dayMax,
      "day",
      input.change24h > dayMax
        ? `Day already +${input.change24h.toFixed(1)}% (> ${dayMax.toFixed(1)}% ATR band) — the move happened without you`
        : input.change24h < dayMin
          ? `Day ${input.change24h.toFixed(1)}% (< ${dayMin.toFixed(1)}%) — falling knife, not a long`
          : "",
    ]);
    gates.push([input.vol5mUsd > V2.volLowUsd, "volume", `Low money — ${fmtUsd(input.vol5mUsd)} in 5m`]);
    gates.push([input.trades5m >= V2.tradesLow, "liquidity", `Too thin — ${input.trades5m} trades`]);
    gates.push([input.rvol >= V2.goMinRvol, "expansion", `No volume expansion (${input.rvol.toFixed(2)}×)`]);
    gates.push([input.buyPct >= V2.goMinBuyPctLong, "crowd", `Buyers only ${input.buyPct.toFixed(0)}% of tape`]);
    gates.push([
      input.btcChange1h === null || input.btcChange1h > -0.1,
      "btc1h",
      `BTC 1h ${input.btcChange1h?.toFixed(2)}% falling — bull-trap risk`,
    ]);
    const spread = input.spreadBps ?? null;
    gates.push([spread === null || spread <= V2.spreadMaxBps, "spread", spread !== null ? `Spread ${spread.toFixed(1)} bps — too wide to exit honestly` : ""]);
    gates.push([!trade.blocked, "plan", trade.blockReason ?? ""]);
    gates.push([
      !(axes.wallUnbreakable && input.askWall !== null && input.price < input.askWall.price),
      "wall",
      "Below an unbreakable wall — wait for the break",
    ]);
    for (const [ok, gate, note] of gates) {
      if (!ok) {
        verdict = "watch";
        demoteGate = gate;
        if (note) axes.warnings.push(note);
        break; // first blocking gate wins (shadow-log semantics)
      }
    }
  }

  return {
    score,
    verdict,
    checks: axes.checks,
    trade,
    warnings: axes.warnings,
    demoteGate,
    axes: {
      participation: axes.participation,
      directional: axes.directional,
      microstructure: axes.microstructure,
    },
  };
}

/** SHORT side — mirrored filters with its own calibration. */
export function assessShort(input: V2Input, cal?: Calibration | null, opts?: { replay?: boolean }): SideAssessment {
  const axes = axisResult(input, -1);
  const score = axes.participation + axes.directional + axes.microstructure;
  const mode = btcModeFor(input.btcChange15m, input.btcAtr15m);

  let verdict: SideVerdict;
  if (mode === "bull") {
    verdict = "blocked_btc";
    axes.checks.push({ label: "BTC regime", pass: false, note: `BTC 15m ${input.btcChange15m?.toFixed(2)}% vs its ATR — bull mode, shorts blocked` });
  } else {
    axes.checks.push({
      label: "BTC regime",
      pass: true,
      note:
        mode === "dump"
          ? `BTC 15m ${input.btcChange15m?.toFixed(2)}% vs its ATR — dumping, shorts favoured`
          : `BTC 15m ${input.btcChange15m?.toFixed(2)}% vs its ATR — flat, needs ${V2.goScoreFlat}+`,
    });
    const threshold = mode === "dump" ? V2.goScoreShortDump : V2.goScoreFlat;
    if (score >= threshold) verdict = "go";
    else if (score >= V2.watchScore) verdict = "watch";
    else verdict = "skip";
  }

  if (input.isStablecoin) axes.checks.push({ label: "Stablecoin", pass: false, note: "pegged asset — veto" });

  const trade = buildTradePlan(
    "short",
    input.price,
    input.atrPct,
    input.bidWall,
    input.vol5mUsd,
    { takerFlow5mUsd: input.vol5mUsd * (1 - input.buyPct / 100), askDepthToTp2Usd: null },
  );

  let demoteGate: string | null = null;
  if (verdict === "go") {
    const gates: Array<[boolean, string, string]> = [];
    // The expectancy gate, mirrored — skipped in replay.
    if (!opts?.replay) {
      const calP = lookupHitRate(cal ?? DEFAULT_CALIBRATION, score);
      if (calP !== null) {
        const estR = expectancyEstimateR(calP.p, trade?.riskPct ?? 1);
        gates.push([
          estR >= V2.minExpectancyR,
          "expectancy",
          `Calibrated hit rate ${(calP.p * 100).toFixed(0)}% (n=${calP.n}) → est. ${estR >= 0 ? "+" : ""}${estR.toFixed(2)}R per trade — below the GO floor`,
        ]);
      }
    }
    const age = input.listingAgeDays ?? null;
    gates.push([age === null || age >= V2.listingMinAgeDays, "listing", age !== null ? `Listed ${age.toFixed(1)} days ago — baselines unreliable` : ""]);
    const blocks = input.historyBlocks ?? null;
    gates.push([blocks === null || blocks >= V2.historyMinBlocks, "history", blocks !== null ? `Only ${blocks} baseline blocks — not trusted yet` : ""]);
    gates.push([axes.momentumPass, "momentum", "Residual move under the ATR bar — drift, not a dump"]);
    const band = dayBandPct(input.atrPct);
    const shortMin = -Math.min(15, Math.max(Math.abs(V2.goShortDayMin) / 1.5, band * 1.5));
    const shortMax = Math.min(V2.goShortDayMax, Math.max(2, band));
    gates.push([
      input.change24h >= shortMin && input.change24h <= shortMax,
      "day",
      input.change24h < shortMin
        ? `Day ${input.change24h.toFixed(1)}% — crash mostly done, bounce risk`
        : `Day +${input.change24h.toFixed(1)}% — day trend fights the short`,
    ]);
    gates.push([input.vol5mUsd > V2.volLowUsd, "volume", `Low money — ${fmtUsd(input.vol5mUsd)} in 5m`]);
    gates.push([input.trades5m >= V2.tradesLow, "liquidity", `Too thin — ${input.trades5m} trades`]);
    gates.push([input.rvol >= V2.goMinRvol, "expansion", `No volume expansion (${input.rvol.toFixed(2)}×)`]);
    gates.push([input.buyPct <= V2.goMinBuyPctShort, "crowd", `Sellers only ${(100 - input.buyPct).toFixed(0)}% of tape`]);
    gates.push([input.btcChange1h === null || input.btcChange1h < 0.1, "btc1h", `BTC 1h ${input.btcChange1h?.toFixed(2)}% rising — dip gets bought`]);
    const spread = input.spreadBps ?? null;
    gates.push([spread === null || spread <= V2.spreadMaxBps, "spread", spread !== null ? `Spread ${spread.toFixed(1)} bps — too wide` : ""]);
    gates.push([!trade.blocked, "plan", trade.blockReason ?? ""]);
    gates.push([
      !(axes.wallUnbreakable && input.bidWall !== null && input.price > input.bidWall.price),
      "wall",
      "Above an unbreakable bid floor — squeeze risk",
    ]);
    for (const [ok, gate, note] of gates) {
      if (!ok) {
        verdict = "watch";
        demoteGate = gate;
        if (note) axes.warnings.push(note);
        break;
      }
    }
  }

  return {
    score,
    verdict,
    checks: axes.checks,
    trade,
    warnings: axes.warnings,
    demoteGate,
    axes: {
      participation: axes.participation,
      directional: axes.directional,
      microstructure: axes.microstructure,
    },
  };
}

// ── Scenario map — what could happen, BEFORE the decision ────────────────────

export type Scenario = { tone: "bull" | "base" | "bear"; title: string; body: string };

export function buildScenarios(
  input: V2Input,
  long: SideAssessment,
  short: SideAssessment,
  hitRate?: { p: number; n: number } | null,
): Scenario[] {
  const bull: string[] = [];
  const bear: string[] = [];
  const w = input.askWall;

  if (input.rvol >= 2) bull.push(`volume holds above ${input.rvol.toFixed(1)}× its time-of-day baseline`);
  if (input.buyPct >= 55) bull.push(`takers keep buying (${input.buyPct.toFixed(0)}% of tape)`);
  if (input.btcChange15m !== null && input.btcChange15m > 0.1) bull.push("BTC regime stays supportive");
  if (w && input.price > w.price) bull.push("the broken wall stays broken — old resistance becomes support");
  if (!w && input.askWallKnown) bull.push("thin asks overhead — runway to TP2");
  if ((input.oiChange15m ?? 0) > 0.3) bull.push(`open interest +${(input.oiChange15m ?? 0).toFixed(1)}% — new money, not a squeeze`);

  if (input.buyPct < 45) bear.push(`sellers own the tape (${(100 - input.buyPct).toFixed(0)}% sells)`);
  if (input.rvol < 1.2) bear.push("volume fades back to baseline — the move starves");
  if (w && input.price < w.price && w.valueUsd > input.vol5mUsd * (input.buyPct / 100)) bear.push(`the ${fmtUsd(w.valueUsd)} wall refuses to break`);
  if (input.btcChange15m !== null && input.btcChange15m < -0.1) bear.push("BTC rolls over");
  if (input.trades5m < V2.tradesLow) bear.push("thin trade count — one whale flips it");
  if ((input.cvdSlope15m ?? 0) < -0.1 && input.change15m > 0) bear.push("CVD diverging down while price rises — distribution");
  if ((input.fundingRatePct ?? 0) > V2.fundingCrowdedPct) bear.push(`funding +${(input.fundingRatePct ?? 0).toFixed(2)}%/8h — crowded longs unwind fast`);

  const risk = long.trade?.riskPct ?? 1;
  const calibrationNote =
    hitRate && hitRate.n >= 30
      ? ` Historically this feature band reached TP1 before the stop ${(hitRate.p * 100).toFixed(0)}% of the time (n=${hitRate.n}, your backtest).`
      : "";
  const scenarios: Scenario[] = [
    {
      tone: "bull",
      title: long.verdict === "go" ? "Confirms → ride to TP" : "Bull case",
      body: `${bull.length > 0 ? bull.slice(0, 3).join("; ") : "momentum and flow keep building"}. Price clears +${(long.trade?.tp1Pct ?? risk * 2).toFixed(1)}% (TP1, half off), runner to +${(long.trade?.tp2Pct ?? risk * 3.5).toFixed(1)}%.${calibrationNote}`,
    },
    {
      tone: "base",
      title: "Base case — chop",
      body: `Volume normalises, price chops ±${(input.atrPct ?? 0.5).toFixed(2)}% for an hour. No trade needed — waiting is the position; the 2-hour time stop closes it if nothing happens.`,
    },
    {
      tone: "bear",
      title: "Invalidated → stop",
      body: `${bear.length > 0 ? bear.slice(0, 3).join("; ") : "flow flips against the setup"}. Stop −${risk.toFixed(1)}% takes the small loss; short watch begins if tape stays red (short score ${Math.round(short.score)}).`,
    },
  ];
  return scenarios;
}

// ── Row-level V2 assessment (combines both sides) ────────────────────────────

export type RowVerdict = "go_long" | "go_short" | "watch" | "skip" | "blocked_btc" | "stable";

export type RowV2 = {
  longScore: number; // UNCAPPED — display should cap at 100 with a "+" marker
  shortScore: number;
  verdict: RowVerdict;
  longVerdict: SideVerdict;
  shortVerdict: SideVerdict;
  checks: V2Check[];
  shortChecks: V2Check[];
  warnings: string[];
  wall: { price: number; valueUsd: number; distPct: number } | null;
  bidWall: { price: number; valueUsd: number; distPct: number } | null;
  wallKnown: boolean;
  wallBroken: boolean | null;
  atrPct: number | null;
  trade: TradePlan | null;
  shortTrade: TradePlan | null;
  scenarios: Scenario[];
  // V2.1 additions.
  axes?: { participation: number; directional: number; microstructure: number };
  hitRate?: { p: number; n: number } | null;
  wallAgeSec?: number | null;
  spreadBps?: number | null;
  futures?: { oiChange15m: number | null; fundingRatePct: number | null; lsRatio: number | null };
  longDemoteGate?: string | null; // first gate vetoing a would-be long GO (shadow logging)
  shortDemoteGate?: string | null;
};

export function assessRow(input: V2Input, cal?: Calibration | null): RowV2 {
  // The user's calibration (from their own backtest) wins; the shipped
  // measured default stands in otherwise — the row always carries a hit-rate
  // label and the expectancy gate always has numbers to work with.
  const long = assessLong(input, cal);
  const short = assessShort(input, cal);
  const effectiveHitRate = lookupHitRate(cal ?? DEFAULT_CALIBRATION, Math.round(long.score));
  const scenarios = buildScenarios(input, long, short, effectiveHitRate);

  let verdict: RowVerdict;
  if (input.isStablecoin) verdict = "stable";
  else if (long.verdict === "go") verdict = "go_long";
  else if (short.verdict === "go") verdict = "go_short";
  else if (long.verdict === "blocked_btc") verdict = "blocked_btc";
  else if (long.verdict === "watch" || short.verdict === "watch") verdict = "watch";
  else verdict = "skip";

  const w = input.askWall;
  const bid = input.bidWall;

  return {
    longScore: Math.round(long.score),
    shortScore: Math.round(short.score),
    verdict,
    longVerdict: long.verdict,
    shortVerdict: short.verdict,
    checks: long.checks,
    shortChecks: short.checks,
    warnings: [...long.warnings, ...(short.verdict === "go" ? ["Short setup stronger — tape is dumping"] : [])],
    wall:
      w !== null
        ? { price: w.price, valueUsd: w.valueUsd, distPct: input.price > 0 ? ((w.price - input.price) / input.price) * 100 : 0 }
        : null,
    bidWall:
      bid !== null
        ? { price: bid.price, valueUsd: bid.valueUsd, distPct: input.price > 0 ? ((bid.price - input.price) / input.price) * 100 : 0 }
        : null,
    wallKnown: input.askWallKnown,
    wallBroken: input.wallBrokenConfirmed,
    atrPct: input.atrPct,
    trade: long.trade,
    shortTrade: short.trade,
    scenarios,
    axes: long.axes,
    hitRate: effectiveHitRate ?? null,
    wallAgeSec: input.wallAgeSec ?? null,
    spreadBps: input.spreadBps ?? null,
    futures:
      input.oiChange15m != null || input.fundingRatePct != null || input.lsRatio != null
        ? { oiChange15m: input.oiChange15m ?? null, fundingRatePct: input.fundingRatePct ?? null, lsRatio: input.lsRatio ?? null }
        : undefined,
    longDemoteGate: long.demoteGate,
    shortDemoteGate: short.demoteGate,
  };
}

// ── Cooldown ledger — stop the flip-flop ─────────────────────────────────────

export class CooldownLedger {
  private longBlocked = new Map<string, number>();
  private shortBlocked = new Map<string, number>();
  private lastLong = new Map<string, number>();
  private lastShort = new Map<string, number>();

  /** Call when a bearish (exit/dump) signal fires — blocks longs for an hour. */
  bearishSignal(pair: string, now = Date.now()): void {
    this.longBlocked.set(pair, Math.max(this.longBlocked.get(pair) ?? 0, now + V2.longBlockAfterBearishMs));
  }

  longSignal(pair: string, now = Date.now()): void {
    this.lastLong.set(pair, now);
    this.shortBlocked.set(pair, Math.max(this.shortBlocked.get(pair) ?? 0, now + V2.shortBlockAfterLongMs));
  }

  shortSignal(pair: string, now = Date.now()): void {
    this.lastShort.set(pair, now);
    this.longBlocked.set(pair, Math.max(this.longBlocked.get(pair) ?? 0, now + V2.longBlockAfterShortMs));
  }

  longAllowed(pair: string, now = Date.now()): boolean {
    return (this.longBlocked.get(pair) ?? 0) <= now;
  }

  shortAllowed(pair: string, now = Date.now()): boolean {
    return (this.shortBlocked.get(pair) ?? 0) <= now;
  }

  /** Has this pair fired the same-side go signal recently? (repeat damping) */
  repeatLong(pair: string, now = Date.now()): boolean {
    return now - (this.lastLong.get(pair) ?? 0) < V2.signalRepeatMs;
  }

  repeatShort(pair: string, now = Date.now()): boolean {
    return now - (this.lastShort.get(pair) ?? 0) < V2.signalRepeatMs;
  }

  remainingLongBlockMs(pair: string, now = Date.now()): number {
    return Math.max(0, (this.longBlocked.get(pair) ?? 0) - now);
  }

  /** V2.1: a regime flip voids directional blocks earned in the old regime —
   *  a bearish block from a dump regime must not persist into a bull flip
   *  (audit §10). Repeat dampers survive. */
  resetBlocks(): void {
    this.longBlocked.clear();
    this.shortBlocked.clear();
  }
}

// ── Portfolio guard — correlation, concurrency, kill switch (audit §5.2) ─────

export type PortfolioDecision = { ok: boolean; reason: string | null };

/** Pearson correlation of two equal-length return series. */
export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 20) return null;
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < n; i += 1) {
    const prevA = a[i - 1];
    const prevB = b[i - 1];
    if (prevA > 0 && prevB > 0) {
      ra.push((a[i] - prevA) / prevA);
      rb.push((b[i] - prevB) / prevB);
    }
  }
  if (ra.length < 19) return null;
  const ma = ra.reduce((x, y) => x + y, 0) / ra.length;
  const mb = rb.reduce((x, y) => x + y, 0) / rb.length;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < ra.length; i += 1) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  if (va <= 0 || vb <= 0) return null;
  return cov / Math.sqrt(va * vb);
}

/** Returns the 1m close series of a row (spark) as prices. */
export function sparkOf(row: { spark: number[] }): number[] {
  return row.spark;
}

export class PortfolioGuard {
  private open: Array<{ pair: string; side: "long" | "short"; firedAt: number; spark: number[] }> = [];
  private lossStreak = 0;
  private killedUntil = 0;
  private dayKey = "";
  private dayLossR = 0;

  /** Register a fired GO signal so later candidates are checked against it. */
  register(pair: string, side: "long" | "short", spark: number[], now = Date.now()): void {
    this.open.push({ pair, side, firedAt: now, spark });
    this.open = this.open.filter((o) => now - o.firedAt < 45 * 60_000);
  }

  /** Record a graded outcome (for the kill switch). pnlR in units of risk. */
  registerOutcome(pnlR: number, now = Date.now()): void {
    const key = new Date(now).toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayLossR = 0;
      this.lossStreak = 0; // a new day clears the loss streak too
    }
    if (pnlR < 0) {
      this.lossStreak += 1;
      this.dayLossR += pnlR;
      if (this.lossStreak >= V2.killSwitchLossStreak || this.dayLossR <= V2.killSwitchDayLossR) {
        this.killedUntil = new Date(`${key}T23:59:59Z`).getTime() + 1;
      }
    } else if (pnlR > 0) {
      this.lossStreak = 0;
    }
  }

  killed(now = Date.now()): boolean {
    return now < this.killedUntil;
  }

  killReason(now = Date.now()): string | null {
    if (!this.killed(now)) return null;
    return `Kill switch active — ${this.lossStreak} straight losses / ${this.dayLossR.toFixed(1)}R today. New entries paused until tomorrow; manage what is open.`;
  }

  /** May a new GO signal fire for this pair/side given the open book? */
  allow(pair: string, side: "long" | "short", spark: number[], sparks: Map<string, number[]>, now = Date.now()): PortfolioDecision {
    if (this.killed(now)) return { ok: false, reason: this.killReason(now) ?? "kill switch" };
    this.open = this.open.filter((o) => now - o.firedAt < 45 * 60_000);
    if (this.open.length >= V2.maxConcurrentSignals) {
      return { ok: false, reason: `${V2.maxConcurrentSignals} positions already open — this is one book, not ${V2.maxConcurrentSignals} independent bets` };
    }
    for (const o of this.open) {
      if (o.pair === pair) return { ok: false, reason: null }; // same pair — cooldown handles it
      const other = sparks.get(o.pair);
      const rho = other ? correlation(spark, other) : null;
      if (rho !== null && rho > V2.correlationMax) {
        return { ok: false, reason: `ρ ${rho.toFixed(2)} with open ${o.pair} — same trade wearing a different ticker` };
      }
    }
    return { ok: true, reason: null };
  }
}

// ── Calibration — turn the user's own backtest into a hit-rate estimate ─────

export type CalibrationBin = { scoreMin: number; n: number; decided: number; hitRate: number };
export type Calibration = { updatedAt: string; days: number; coins: number; bins: CalibrationBin[] };

/** Bin trades by uncapped score → empirical P(TP1 before stop). */
export function buildCalibration(trades: BacktestTrade[], days: number, coins: number): Calibration {
  const edges = [0, 45, 50, 55, 60, 65, 70, 80, 200];
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const inBin = trades.filter((t) => t.score >= edges[i] && t.score < edges[i + 1]);
    const decided = inBin.filter((t) => t.outcome !== "timeout").length;
    const hits = inBin.filter((t) => t.outcome === "win" || t.outcome === "big_win" || t.outcome === "be").length;
    if (inBin.length > 0) bins.push({ scoreMin: edges[i], n: inBin.length, decided, hitRate: decided > 0 ? hits / decided : 0 });
  }
  return { updatedAt: new Date().toISOString(), days, coins, bins };
}

/** Lookup the empirical hit rate for an uncapped score (needs n ≥ 30). */
export function lookupHitRate(cal: Calibration | null | undefined, score: number): { p: number; n: number } | null {
  if (!cal || cal.bins.length === 0) return null;
  let best: CalibrationBin | null = null;
  for (const b of cal.bins) {
    if (score >= b.scoreMin && b.n >= 30 && (best === null || b.scoreMin > best.scoreMin)) best = b;
  }
  if (!best) return null;
  return { p: best.hitRate, n: best.decided };
}

// ── The measured default calibration ─────────────────────────────────────────
//
// Shipped so the expectancy gate works before the user ever runs a backtest.
// Measured 2025-11-07: 90 days of 5m bars, 8 mid-cap pairs (volume ranks
// 50-130 — the anomaly universe's home turf), net of the 0.25% round-trip
// cost, pessimistic same-bar ordering, partial exits at TP1 with breakeven
// runners. This is the honest baseline the app boots with; any backtest the
// user runs replaces it with their own window. See ALGORITHM.md §8.2.
export const DEFAULT_CALIBRATION: Calibration = {
  updatedAt: "2025-11-07",
  days: 90,
  coins: 8,
  bins: [
    { scoreMin: 0, n: 18, decided: 15, hitRate: 0.2 },
    { scoreMin: 40, n: 138, decided: 110, hitRate: 0.24 },
    { scoreMin: 50, n: 302, decided: 240, hitRate: 0.26 },
    { scoreMin: 60, n: 603, decided: 480, hitRate: 0.26 },
    { scoreMin: 70, n: 456, decided: 360, hitRate: 0.25 },
    { scoreMin: 80, n: 79, decided: 60, hitRate: 0.38 },
  ],
};

/**
 * Estimated net expectancy in R for a hit-rate p and a stop distance.
 * Structure: a "hit" means TP1 printed before the stop (partial 50% off at
 * 2R; the runner then either reaches 3.5R or dies at breakeven — assumed
 * 50/50, so the average hit pays 1.875R gross). A loss pays −1R. The
 * round-trip cost (backtestCostPct) is charged in R units on every trade:
 * c = cost / stopPct, which is why tight stops on quiet coins are so hard
 * to pay for.
 */
export function expectancyEstimateR(p: number, stopPct: number): number {
  const c = V2.backtestCostPct / Math.max(0.1, stopPct);
  const hitR = V2.partialTp1Fraction * V2.tp1Mult + (1 - V2.partialTp1Fraction) * (0.5 * V2.tp2Mult + 0.5 * 0);
  const lossR = 1;
  return p * (hitR - c) - (1 - p) * (lossR + c);
}

// ── Backtest core — honest edition ───────────────────────────────────────────
//
// Replays 5-minute bars through the same engine (wall filter off — historical
// order books are not free; stated in the UI) and grades every go-signal
// against its own stop/targets WITH:
//   • fees + slippage on every trade (net stats),
//   • partial exit at TP1, breakeven runner, TP2 runner,
//   • pessimistic same-bar ordering (stop wins),
//   • a shadow log of every gate rejection with its would-be outcome,
//   • 2h time stop = exit at the last close.

export type BacktestBar = {
  t: number; // open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  quoteVol: number; // USD volume of the bar
  trades: number;
  takerBuyQuote: number; // USD taker-buy volume of the bar
};

export type BacktestTrade = {
  pair: string;
  side: "long" | "short";
  time: number; // signal bar open time
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  exitTime: number | null;
  exitPrice: number | null;
  outcome: "win" | "big_win" | "be" | "loss" | "timeout";
  pnlPct: number; // gross
  pnlNetPct: number; // net of fees + slippage
  bars: number;
  score: number; // uncapped
};

export type ShadowEntry = {
  pair: string;
  side: "long" | "short";
  gate: string; // the first gate that vetoed the would-be GO
  time: number;
  outcome: BacktestTrade["outcome"];
  pnlNetPct: number;
};

export type BacktestStats = {
  trades: number;
  wins: number;
  bigWins: number;
  be: number; // partial at TP1, runner stopped at breakeven
  losses: number;
  timeouts: number;
  winRate: number | null; // (wins + bigWins + be) / decided — P(TP1 before stop)
  winRateCi: { lo: number; hi: number } | null; // Wilson 95%
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null; // net gross win / gross loss
  expectancyPct: number | null; // net, per trade
  expectancyR: number | null; // net expectancy in units of risk
  avgRiskPct: number | null;
  totalTrades: number;
};

export function emptyStats(): BacktestStats {
  return {
    trades: 0,
    wins: 0,
    bigWins: 0,
    be: 0,
    losses: 0,
    timeouts: 0,
    winRate: null,
    winRateCi: null,
    avgWinPct: null,
    avgLossPct: null,
    profitFactor: null,
    expectancyPct: null,
    expectancyR: null,
    avgRiskPct: null,
    totalTrades: 0,
  };
}

/** Wilson score interval — the honest CI on a win rate (audit §3.5). */
export function wilsonCi(wins: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (n === 0) return null;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - spread) / denom), hi: Math.min(1, (centre + spread) / denom) };
}

const MAX_FORWARD_BARS = 24; // 2 hours — the time stop

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Runs the V2 long+short simulation over one symbol's 5m bars, with the
 * shadow log collecting every gate veto and its would-be outcome.
 */
export function backtestSymbol(
  pair: string,
  bars: BacktestBar[],
  btcBars: BacktestBar[],
): { longs: BacktestTrade[]; shorts: BacktestTrade[]; shadow: ShadowEntry[] } {
  const longs: BacktestTrade[] = [];
  const shorts: BacktestTrade[] = [];
  const shadow: ShadowEntry[] = [];
  if (bars.length < 40) return { longs, shorts, shadow };

  const ledger = new CooldownLedger();
  const atrCaches = new Map<number, number | null>();

  // Rolling ATR on 5m bars → estimated 1m ATR via √time scaling.
  const atrAt = (i: number): number | null => {
    const cached = atrCaches.get(i);
    if (cached !== undefined) return cached;
    const slice = bars.slice(Math.max(0, i - 15), i + 1).map((b) => ({ high: b.h, low: b.l, close: b.c }));
    const atr = slice.length >= 15 ? atrPctFromCandles(slice, 14) : null;
    const est = atr !== null ? atr / Math.sqrt(5) : null;
    atrCaches.set(i, est);
    return est;
  };

  const btcIndex = new Map<number, number>(); // 5m-bucket → index
  for (let i = 0; i < btcBars.length; i += 1) btcIndex.set(Math.floor(btcBars[i].t / 300_000), i);

  const btcCloseAt = (t: number, backBars: number): number | null => {
    const i = btcIndex.get(Math.floor(t / 300_000) - 1);
    if (i === undefined || i < backBars) return null;
    return btcBars[i - backBars]?.c ?? null;
  };
  const btcChange15mAt = (t: number): number | null => {
    const end = btcCloseAt(t, 0);
    const start = btcCloseAt(t, 3);
    return end !== null && start !== null && start > 0 ? ((end - start) / start) * 100 : null;
  };
  const btcChange5mAt = (t: number): number | null => {
    const end = btcCloseAt(t, 0);
    const start = btcCloseAt(t, 1);
    return end !== null && start !== null && start > 0 ? ((end - start) / start) * 100 : null;
  };
  const btcChange1hAt = (t: number): number | null => {
    const end = btcCloseAt(t, 0);
    const start = btcCloseAt(t, 12);
    return end !== null && start !== null && start > 0 ? ((end - start) / start) * 100 : null;
  };
  // BTC's own 15m ATR (regime in ATR units) — rolling over its 5m bars.
  const btcAtr15mCache = new Map<number, number | null>();
  const btcAtr15mAt = (t: number): number | null => {
    const i = btcIndex.get(Math.floor(t / 300_000) - 1);
    if (i === undefined || i < 15) return null;
    const key = i;
    const cached = btcAtr15mCache.get(key);
    if (cached !== undefined) return cached;
    const slice = btcBars.slice(i - 14, i + 1).map((b) => ({ high: b.h, low: b.l, close: b.c }));
    const atr = atrPctFromCandles(slice, 14);
    const est = atr !== null ? atr / Math.sqrt(3) : null; // 3 × 5m bars = 15m
    btcAtr15mCache.set(key, est);
    return est;
  };

  // β from the last 96 bars (8h) of 5m returns vs BTC. β drifts slowly, so it
  // is computed once per 12-bar (1h) bucket at the bucket's FIRST bar (using
  // only data ≤ that bar — no look-ahead) and reused across the bucket. This
  // keeps replay ~12× cheaper with identical trading semantics.
  const betaCache = new Map<number, number | null>();
  const betaAt = (i: number): number | null => {
    const key = Math.floor(i / 12);
    const cached = betaCache.get(key);
    if (cached !== undefined) return cached;
    const anchor = key * 12; // first bar of the bucket — computed from data ≤ anchor
    const window = 96;
    if (anchor < window + 1) {
      betaCache.set(key, null);
      return null;
    }
    const rs: number[] = [];
    const rb: number[] = [];
    for (let k = anchor - window + 1; k <= anchor; k += 1) {
      const coinPrev = bars[k - 1]?.c ?? 0;
      const coinCur = bars[k]?.c ?? 0;
      const btcBucket = btcIndex.get(Math.floor(bars[k]?.t / 300_000) ?? -1);
      const btcPrev = btcBucket !== undefined ? btcBars[btcBucket - 1]?.c ?? 0 : 0;
      const btcCur = btcBucket !== undefined ? btcBars[btcBucket]?.c ?? 0 : 0;
      if (coinPrev > 0 && btcPrev > 0) {
        rs.push((coinCur - coinPrev) / coinPrev);
        rb.push((btcCur - btcPrev) / btcPrev);
      }
    }
    let beta: number | null = null;
    if (rs.length >= 60) {
      const ms = rs.reduce((a, b) => a + b, 0) / rs.length;
      const mb = rb.reduce((a, b) => a + b, 0) / rb.length;
      let cov = 0;
      let varB = 0;
      for (let k = 0; k < rs.length; k += 1) {
        cov += (rs[k] - ms) * (rb[k] - mb);
        varB += (rb[k] - mb) ** 2;
      }
      if (varB > 1e-12) {
        const raw = cov / varB;
        beta = Math.min(3, Math.max(0.1, raw)); // sanity-clamped
      }
    }
    betaCache.set(key, beta);
    return beta;
  };

  // Grade with partial-exit management and costs. Entry = the OPEN of the
  // signal bar — the first price you could actually trade once the closed-bar
  // signal is visible, which matches the live engine (it enters at the current
  // tick, not one bar of drift later). Stops/targets are checked from the
  // entry bar itself onward; same-bar stop + target still counts the stop
  // (pessimistic ordering).
  const grade = (side: "long" | "short", signalBar: number): BacktestTrade | null => {
    const bar = bars[signalBar];
    if (!bar) return null;
    const entry = bar.o > 0 ? bar.o : bar.c;
    const atr = atrAt(signalBar);
    const plan = buildTradePlan(side, entry, atr, null, bar.quoteVol);
    const partial = V2.partialTp1Fraction;
    let partialTaken = false;
    const cost = V2.backtestCostPct;

    for (let j = signalBar; j < Math.min(bars.length, signalBar + MAX_FORWARD_BARS); j += 1) {
      const fwd = bars[j];
      if (!fwd) break;
      if (!partialTaken) {
        const hitStop = side === "long" ? fwd.l <= plan.stop : fwd.h >= plan.stop;
        const hitTp2 = side === "long" ? fwd.h >= plan.tp2 : fwd.l <= plan.tp2;
        const hitTp1 = side === "long" ? fwd.h >= plan.tp1 : fwd.l <= plan.tp1;
        // Pessimistic ordering: same-bar stop + target → stop wins. The entry
        // bar itself can stop you out — a fill at the open can be stopped
        // within the same 5 minutes, and that is real.
        if (hitStop) {
          return {
            pair, side, time: bar.t, entry, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2,
            exitTime: fwd.t, exitPrice: plan.stop, outcome: "loss", pnlPct: -plan.riskPct, pnlNetPct: -plan.riskPct - cost,
            bars: Math.max(1, j - signalBar), score: 0,
          };
        }
        if (hitTp2) {
          const pnl = partial * plan.tp1Pct + (1 - partial) * plan.tp2Pct;
          return {
            pair, side, time: bar.t, entry, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2,
            exitTime: fwd.t, exitPrice: plan.tp2, outcome: "big_win", pnlPct: pnl, pnlNetPct: pnl - cost,
            bars: Math.max(1, j - signalBar), score: 0,
          };
        }
        if (hitTp1) {
          partialTaken = true; // half off at TP1; stop moves to breakeven
          continue;
        }
      } else {
        // Runner phase: stop is at entry (breakeven), target TP2.
        const hitBe = side === "long" ? fwd.l <= plan.entry : fwd.h >= plan.entry;
        const hitTp2 = side === "long" ? fwd.h >= plan.tp2 : fwd.l <= plan.tp2;
        if (hitBe) {
          const pnl = partial * plan.tp1Pct;
          return {
            pair, side, time: bar.t, entry, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2,
            exitTime: fwd.t, exitPrice: plan.entry, outcome: "be", pnlPct: pnl, pnlNetPct: pnl - cost,
            bars: Math.max(1, j - signalBar), score: 0,
          };
        }
        if (hitTp2) {
          const pnl = partial * plan.tp1Pct + (1 - partial) * plan.tp2Pct;
          return {
            pair, side, time: bar.t, entry, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2,
            exitTime: fwd.t, exitPrice: plan.tp2, outcome: "big_win", pnlPct: pnl, pnlNetPct: pnl - cost,
            bars: Math.max(1, j - signalBar), score: 0,
          };
        }
      }
    }
    // Time stop (2h): exit at the last close.
    const last = bars[Math.min(bars.length - 1, signalBar + MAX_FORWARD_BARS - 1)];
    if (!last) return null;
    const move = side === "long" ? ((last.c - entry) / entry) * 100 : ((entry - last.c) / entry) * 100;
    const pnl = partialTaken ? partial * plan.tp1Pct + (1 - partial) * move : move;
    return {
      pair, side, time: bar.t, entry, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2,
      exitTime: last.t, exitPrice: last.c, outcome: "timeout", pnlPct: pnl, pnlNetPct: pnl - cost,
      bars: MAX_FORWARD_BARS, score: 0,
    };
  };

  for (let i = 288; i < bars.length - 1; i += 1) {
    const bar = bars[i];
    const prev = bars[i - 1];
    if (!bar || !prev || bar.c <= 0) continue;

    // ── Volume baseline: median of the SAME-UTC-HOUR blocks over the prior
    // 24h, excluding the last 30 min (self-exclusion), with a floor and an
    // honest block count (audit §2.3). Falls back to the full-window median
    // when the same-hour sample is too small.
    const hour = Math.floor((bar.t % 86_400_000) / 3_600_000);
    const windowStart = Math.max(0, i - 288);
    const sameHour: number[] = [];
    const allBlocks: number[] = [];
    const sizeSeries: number[] = [];
    for (let k = windowStart; k <= i - 7; k += 1) {
      const b = bars[k];
      if (!b) continue;
      allBlocks.push(b.quoteVol);
      sizeSeries.push(b.trades > 0 ? b.quoteVol / b.trades : 0);
      if (Math.floor((b.t % 86_400_000) / 3_600_000) === hour) sameHour.push(b.quoteVol);
    }
    const usableBlocks = allBlocks.length;
    const baselineSource = sameHour.length >= 6 ? sameHour : allBlocks;
    // Floor: a new listing divides by ~0 and shows infinite rvol. The floor
    // is 1/20 of the mean 5m volume implied by the pair's own 24h tape.
    const meanBlock = usableBlocks > 0 ? allBlocks.reduce((a, b) => a + b, 0) / usableBlocks : 0;
    const baseline = Math.max(median(baselineSource), meanBlock / 20);

    const vol5mUsd = prev.quoteVol; // last CLOSED bar is the "now" tape
    const trades5m = prev.trades;
    // Baseline trades for the trade-spike, same window logic.
    const tradeBlocks: number[] = [];
    for (let k = windowStart; k <= i - 7; k += 1) {
      const b = bars[k];
      if (b) tradeBlocks.push(b.trades);
    }
    const tradeBaseline = Math.max(median(tradeBlocks), 1);
    const rvol = baseline > 0 ? vol5mUsd / baseline : 0;
    const tradeSpike = trades5m / tradeBaseline;
    const buyPct = prev.quoteVol > 0 ? (prev.takerBuyQuote / prev.quoteVol) * 100 : 50;

    // CVD slope over the last 3 bars (15m): Σ(tb − sell) / Σvol.
    let tbSum = 0;
    let volSum = 0;
    for (let k = Math.max(0, i - 3); k < i; k += 1) {
      const b = bars[k];
      if (b) {
        tbSum += b.takerBuyQuote - (b.quoteVol - b.takerBuyQuote);
        volSum += b.quoteVol;
      }
    }
    const cvdSlope15m = volSum > 0 ? tbSum / volSum : null;

    // Average trade-size spike: last bar's avg size vs baseline median size.
    const lastAvgSize = prev.trades > 0 ? prev.quoteVol / prev.trades : 0;
    const baseAvgSize = median(sizeSeries);
    const avgTradeSizeSpike = baseAvgSize > 0 ? lastAvgSize / baseAvgSize : null;

    // Momentum on the 5m grid: "now" = the last CLOSED bar (i−1).
    // change5m  = close[i−1] vs close[i−2]  (1 bar = 5m)
    // change15m = close[i−1] vs close[i−4]  (3 bars = 15m)
    // (The old code measured close[i−3] vs close[i−4] — a single stale 5m
    //  bar mislabelled as "15m", skewing every replayed momentum check.)
    const c5m = bars[i - 1].c;
    const change5m = c5m > 0 && bars[i - 2] ? ((c5m - bars[i - 2].c) / bars[i - 2].c) * 100 : 0;
    const change15m = c5m > 0 && bars[i - 4] ? ((c5m - bars[i - 4].c) / bars[i - 4].c) * 100 : 0;
    const change1m = prev.o > 0 ? ((prev.c - prev.o) / prev.o) * 100 : 0; // intra-bar proxy

    // Close strength of the last closed bar, range-weighted by ATR.
    const strengthRaw = prev.h > prev.l ? (prev.c - prev.l) / (prev.h - prev.l) : 0.5;
    const atrNow = atrAt(i - 1);
    const rangePct = prev.c > 0 ? ((prev.h - prev.l) / prev.c) * 100 : 0;
    const rangeWeight = atrNow !== null && atrNow > 0 ? Math.min(1, rangePct / (2 * atrNow)) : 0.5;
    const closeStrength = 0.5 + (strengthRaw - 0.5) * rangeWeight;

    // Residual momentum (β-adjusted).
    const beta = betaAt(i - 1);
    const btc5 = btcChange5mAt(bar.t);
    const btc15 = btcChange15mAt(bar.t);
    const resid5 = beta !== null && btc5 !== null ? change5m - beta * btc5 : null;
    const resid15 = beta !== null && btc15 !== null ? change15m - beta * btc15 : null;

    const stable = stablecoinLike(prev.c, change15m, 0);
    const btcChange15m = btcChange15mAt(bar.t);
    // Rolling 24h change to the last CLOSED bar — 288 bars back.
    const dayStart = bars[Math.max(0, i - 1 - 287)];
    const change24h = dayStart && dayStart.o > 0 ? ((prev.c - dayStart.o) / dayStart.o) * 100 : 0;

    const input: V2Input = {
      base: pair.replace(/USDT$/, ""),
      price: prev.c,
      change1m,
      change5m,
      change15m,
      change24h,
      vol5mUsd,
      rvol,
      trades5m,
      buyPct,
      baseScore: 0,
      tradeSpike,
      closeStrength,
      beta,
      residChange5m: resid5,
      residChange15m: resid15,
      btcChange5m: btc5,
      btcChange15m,
      btcChange1h: btcChange1hAt(bar.t),
      btcAtr15m: btcAtr15mAt(bar.t),
      cvdSlope15m,
      avgTradeSizeSpike,
      atrPct: atrAt(i - 1),
      askWall: null,
      bidWall: null,
      askWallKnown: false, // no historical order books — wall filter honestly off
      wallBrokenConfirmed: null,
      historyBlocks: usableBlocks,
      isStablecoin: stable,
    };

    const now = bar.t;
    // Replay mode: the expectancy gate is OFF in backtests — the replay IS the
    // calibration instrument and must measure the raw signal + classic gates.
    const long = assessLong(input, null, { replay: true });
    const short = assessShort(input, null, { replay: true });

    // Shadow log: every would-be GO that a gate (or the ledger) vetoed, graded
    // as if it had fired — the only way to know whether a gate helps or hurts.
    if (long.verdict === "watch" && long.demoteGate) {
      const t = grade("long", i);
      if (t) shadow.push({ pair, side: "long", gate: long.demoteGate, time: bar.t, outcome: t.outcome, pnlNetPct: t.pnlNetPct });
    }
    if (short.verdict === "watch" && short.demoteGate) {
      const t = grade("short", i);
      if (t) shadow.push({ pair, side: "short", gate: short.demoteGate, time: bar.t, outcome: t.outcome, pnlNetPct: t.pnlNetPct });
    }

    if (long.verdict === "go") {
      if (!ledger.longAllowed(pair, now)) {
        const t = grade("long", i);
        if (t) shadow.push({ pair, side: "long", gate: "cooldown", time: bar.t, outcome: t.outcome, pnlNetPct: t.pnlNetPct });
      } else if (ledger.repeatLong(pair, now)) {
        const t = grade("long", i);
        if (t) shadow.push({ pair, side: "long", gate: "repeat", time: bar.t, outcome: t.outcome, pnlNetPct: t.pnlNetPct });
      } else {
        const trade = grade("long", i);
        if (trade) {
          trade.score = long.score;
          longs.push(trade);
          ledger.longSignal(pair, now);
          if (trade.outcome === "loss") ledger.bearishSignal(pair, trade.exitTime ?? now);
        }
      }
    }
    if (short.verdict === "go") {
      if (!ledger.shortAllowed(pair, now)) {
        const t = grade("short", i);
        if (t) shadow.push({ pair, side: "short", gate: "cooldown", time: bar.t, outcome: t.outcome, pnlNetPct: t.pnlNetPct });
      } else if (ledger.repeatShort(pair, now)) {
        const t = grade("short", i);
        if (t) shadow.push({ pair, side: "short", gate: "repeat", time: bar.t, outcome: t.outcome, pnlNetPct: t.pnlNetPct });
      } else {
        const trade = grade("short", i);
        if (trade) {
          trade.score = short.score;
          shorts.push(trade);
          ledger.shortSignal(pair, now);
        }
      }
    }
  }

  return { longs, shorts, shadow };
}

export function statsFor(trades: BacktestTrade[]): BacktestStats {
  const stats = emptyStats();
  stats.trades = trades.length;
  let grossWin = 0;
  let grossLoss = 0;
  let winSum = 0;
  let lossSum = 0;
  let netSum = 0;
  let riskSum = 0;
  let riskCount = 0;
  for (const t of trades) {
    netSum += t.pnlNetPct;
    if (t.outcome === "win" || t.outcome === "big_win" || t.outcome === "be") {
      if (t.outcome === "big_win") stats.bigWins += 1;
      else if (t.outcome === "be") stats.be += 1;
      else stats.wins += 1;
      grossWin += t.pnlNetPct;
      winSum += t.pnlNetPct;
    } else if (t.outcome === "loss") {
      stats.losses += 1;
      grossLoss += Math.abs(t.pnlNetPct);
      lossSum += t.pnlNetPct;
    } else {
      stats.timeouts += 1;
    }
    if (t.entry > 0 && t.stop > 0) {
      riskSum += Math.abs((t.entry - t.stop) / t.entry) * 100;
      riskCount += 1;
    }
  }
  const hit = stats.wins + stats.bigWins + stats.be;
  const decided = hit + stats.losses;
  stats.winRate = decided > 0 ? hit / decided : null;
  stats.winRateCi = decided > 0 ? wilsonCi(hit, decided) : null;
  stats.avgWinPct = hit > 0 ? winSum / hit : null;
  stats.avgLossPct = stats.losses > 0 ? lossSum / stats.losses : null;
  stats.profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null;
  stats.expectancyPct = trades.length > 0 ? netSum / trades.length : null;
  stats.avgRiskPct = riskCount > 0 ? riskSum / riskCount : null;
  stats.expectancyR = stats.avgRiskPct !== null && stats.avgRiskPct > 0 ? (stats.expectancyPct ?? 0) / stats.avgRiskPct : null;
  stats.totalTrades = trades.length;
  return stats;
}

/** Aggregate per-gate shadow stats: what each veto is actually blocking. */
export type GateEfficacy = { gate: string; blocked: number; hits: number; decided: number; hitRate: number | null; avgPnlNet: number | null };

export function gateEfficacy(shadow: ShadowEntry[]): GateEfficacy[] {
  const byGate = new Map<string, ShadowEntry[]>();
  for (const s of shadow) {
    const list = byGate.get(s.gate) ?? [];
    list.push(s);
    byGate.set(s.gate, list);
  }
  const out: GateEfficacy[] = [];
  for (const [gate, list] of byGate) {
    const decided = list.filter((s) => s.outcome !== "timeout");
    const hits = list.filter((s) => s.outcome === "win" || s.outcome === "big_win" || s.outcome === "be");
    out.push({
      gate,
      blocked: list.length,
      hits: hits.length,
      decided: decided.length,
      hitRate: decided.length > 0 ? hits.length / decided.length : null,
      avgPnlNet: list.length > 0 ? list.reduce((a, s) => a + s.pnlNetPct, 0) / list.length : null,
    });
  }
  out.sort((a, b) => b.blocked - a.blocked);
  return out;
}

// ── Convenience: V2 fields from a live RadarRow-shaped input ─────────────────

export function rowInputFromRadar(
  row: RadarRow,
  extras: {
    atrPct: number | null;
    askWall: V2Wall;
    bidWall: V2Wall;
    askWallKnown: boolean;
    wallBrokenConfirmed: boolean | null;
    btcChange15m: number | null;
    btcChange1h?: number | null;
    isStablecoin?: boolean;
    // V2.1 optional extras.
    tradeSpike?: number;
    closeStrength?: number;
    beta?: number | null;
    residChange5m?: number | null;
    residChange15m?: number | null;
    btcChange5m?: number | null;
    btcAtr15m?: number | null;
    spreadBps?: number | null;
    wallAgeSec?: number | null;
    wallToDepthRatio?: number | null;
    askDepthToTp2Usd?: number | null;
    cvdSlope15m?: number | null;
    avgTradeSizeSpike?: number | null;
    oiChange15m?: number | null;
    fundingRatePct?: number | null;
    lsRatio?: number | null;
    listingAgeDays?: number | null;
    historyBlocks?: number | null;
  },
): V2Input {
  return {
    base: row.base,
    price: row.price,
    change1m: row.change1m,
    change5m: row.change5m,
    change15m: row.change15m,
    change24h: row.change24h,
    vol5mUsd: row.vol5mUsd,
    rvol: row.rvol,
    trades5m: row.trades5m,
    buyPct: row.buyPct,
    baseScore: row.score,
    tradeSpike: extras.tradeSpike ?? row.tradeSpike,
    closeStrength: extras.closeStrength ?? row.closeStrength,
    beta: extras.beta ?? null,
    residChange5m: extras.residChange5m ?? null,
    residChange15m: extras.residChange15m ?? null,
    btcChange5m: extras.btcChange5m ?? null,
    atrPct: extras.atrPct,
    askWall: extras.askWall,
    bidWall: extras.bidWall,
    askWallKnown: extras.askWallKnown,
    wallBrokenConfirmed: extras.wallBrokenConfirmed,
    btcChange15m: extras.btcChange15m,
    btcChange1h: extras.btcChange1h ?? null,
    btcAtr15m: extras.btcAtr15m ?? null,
    spreadBps: extras.spreadBps ?? null,
    wallAgeSec: extras.wallAgeSec ?? null,
    wallToDepthRatio: extras.wallToDepthRatio ?? null,
    askDepthToTp2Usd: extras.askDepthToTp2Usd ?? null,
    cvdSlope15m: extras.cvdSlope15m ?? null,
    avgTradeSizeSpike: extras.avgTradeSizeSpike ?? null,
    oiChange15m: extras.oiChange15m ?? null,
    fundingRatePct: extras.fundingRatePct ?? null,
    lsRatio: extras.lsRatio ?? null,
    listingAgeDays: extras.listingAgeDays ?? null,
    historyBlocks: extras.historyBlocks ?? null,
    isStablecoin: extras.isStablecoin ?? stablecoinLike(row.price, row.change15m, row.change24h),
  };
}
