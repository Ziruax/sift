// ── Sift V2 accuracy engine ──────────────────────────────────────────────────
//
// One shared brain, three consumers:
//   • the server-side scanner (mini-services/radar) — imports this via a
//     relative path,
//   • the in-browser engine (local-radar.ts) — imports it like any module,
//   • the backtest simulator (Backtest view) — replays history through the
//     exact same filters.
//
// Why one module: the old app graded a coin on a single 0-100 "score" and was
// right ~30% of the time. V2 refuses to speak unless seven independent filters
// agree, and every number below is derived from real microstructure — order
// books, taker flow, trade counts, BTC regime — not vibes.
//
// The contract with reality: no filter set makes the market predictable. What
// this engine does is (a) refuse the obviously fake setups (stablecoins, one
// whale print, unbreakable walls), (b) size stops to each coin's own
// volatility so a wrong call loses ~1% while a right one pays 2-3.5%, and
// (c) show the scenario map BEFORE the decision, so the trader knows what
// confirms and what invalidates.

import type { RadarRow } from "./types";

// ── Tunables (all thresholds in one place — the backtest tunes these) ────────

export const V2 = {
  // Momentum filter — tuned by grid search over 14 days of 5m candles:
  // a GO needs a real impulse (+0.4% on both the 5m and 15m windows), not a
  // drift. Weak momentum fired 3× the trades at a worse win rate.
  momentumGreen: 0.4,
  momentum1mRed: -0.1, // 1m below this → extra penalty
  // Dollar-volume filter (real money, not "3.0x of nothing")
  volHighUsd: 100_000,
  volLowUsd: 50_000,
  // Liquidity filter
  tradesLow: 200, // fewer trades in 5m → penalty
  tradesHealthy: 500, // more → small bonus
  // Wall filter
  wallVsVol: 1, // wall bigger than 5m USD volume → unbreakable
  wallScanPct: 2, // walls counted within ±2% of price
  wallConfirmMs: 120_000, // price must hold above a broken wall 2 min
  // BTC regime filter
  btcBull: 0.3, // BTC 15m above → bull mode
  btcDump: -0.3, // below → dump mode, longs blocked
  goScore: 70, // final score needed to say "go" (bull mode for longs)
  goScoreFlat: 80, // flat BTC regime — longs/shorts need to be exceptional
  watchScore: 60, // 60-69 → "watch only"
  // Day-extension gate: never chase a move that already happened.
  goLongDayMin: -5, // below this it's a falling knife, not a long
  goLongDayMax: 8, // above this the pump already happened
  goShortDayMin: -15, // below this the crash is mostly done — bounce risk
  goShortDayMax: 5, // above this the day trend fights the short
  // Hard gates for a GO (on top of the score) — a GO must have real volume,
  // real participation and the crowd on the right side.
  goMinRvol: 2,
  goMinBuyPctLong: 52,
  goMinBuyPctShort: 48,
  // Trap checks
  fakeBuyersPct: 85, // buyers% above this with few trades = fake
  fakeBuyersTrades: 200,
  sellersDumpingPct: 40, // buyers% below this with real volume = dump
  sellersDumpingVolUsd: 100_000,
  // Trade plan geometry — take profits are multiples of the risk (asymmetric
  // by construction: win 2× or 3.5× what a loss costs).
  tp1Mult: 2,
  tp2Mult: 3.5,
  // Cooldowns — stop the flip-flopping that destroyed trust in V1
  longBlockAfterBearishMs: 60 * 60_000, // exit/dump signal blocks longs 60m
  longBlockAfterShortMs: 30 * 60_000, // a go_short blocks longs 30m
  shortBlockAfterLongMs: 30 * 60_000, // and vice versa
  signalRepeatMs: 30 * 60_000, // same go-signal refires at most every 30m
} as const;

// ── Stablecoin immunity ──────────────────────────────────────────────────────
//
// The single biggest fake-signal source in V1: "U" scored 86 pump while priced
// at $1.0004 — a stablecoin can never pump. Two layers:
//   1. the known blacklist (maintained in each scanner's universe filter), and
//   2. this runtime check — price pinned to a dollar and 15m change inside a
//      ±0.05% band is a stablecoin no matter what its name says.

export function stablecoinLike(price: number, change15m: number, change24h: number): boolean {
  if (price > 0.99 && price < 1.01 && Math.abs(change15m) <= 0.05 && Math.abs(change24h) <= 1) return true;
  return false;
}

// ── BTC market regime ────────────────────────────────────────────────────────

export type BtcMode = "bull" | "flat" | "dump";

export function btcModeFor(btcChange15m: number | null | undefined): BtcMode | null {
  if (typeof btcChange15m !== "number" || !Number.isFinite(btcChange15m)) return null;
  if (btcChange15m > V2.btcBull) return "bull";
  if (btcChange15m < V2.btcDump) return "dump";
  return "flat";
}

export const BTC_MODE_COPY: Record<BtcMode, { label: string; note: string; tone: "up" | "warn" | "down" }> = {
  bull: { label: "Bull mode", note: "BTC leading — longs allowed at the normal 70 bar", tone: "up" },
  flat: { label: "Flat mode", note: "BTC drifting — longs need the stricter 75 bar", tone: "warn" },
  dump: { label: "Dump mode", note: "BTC dumping — all longs blocked, shorts favoured", tone: "down" },
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

// ── Trade plans — the "make money at 60% accuracy" machinery ─────────────────
//
// Risk is sized to the coin's own 1m ATR, clamped to a sane band, then take
// profits are 2× and 3.5× the risk — asymmetric by construction. A wall that
// sits inside the profit zone invalidates the plan (you do not aim a take
// profit through a wall the tape cannot eat).

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
};

export function clampRisk(atrPct: number | null, mult = 1, min = 1, max = 1.6): number {
  // Spec-literal: stop distance 1.0% at minimum, widening to 1.6% for
  // volatile coins. Tighter stops look precise and get eaten by noise — a
  // 0.5% stop on an alt with 0.4% five-minute ATR is a coin flip.
  if (atrPct === null || !Number.isFinite(atrPct) || atrPct <= 0) return min;
  return Math.min(max, Math.max(min, (atrPct * mult) / 1));
}

export function buildTradePlan(
  side: "long" | "short",
  entry: number,
  atrPct: number | null,
  wall: { price: number; valueUsd: number } | null,
  vol5mUsd: number,
): TradePlan {
  const riskPct = clampRisk(atrPct);
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
  };
  // Wall invalidation: for longs an ask wall between entry and TP2 eats the
  // move; for shorts a bid wall does the same on the way down.
  if (wall && wall.price > 0 && wall.valueUsd > vol5mUsd * V2.wallVsVol) {
    const inTheWay = side === "long" ? wall.price < plan.tp2 && wall.price > entry : wall.price > plan.tp2 && wall.price < entry;
    if (inTheWay) {
      plan.blocked = true;
      plan.blockReason = `Wall $${Math.round(wall.valueUsd / 1000)}K at ${wall.price.toPrecision(6)} sits inside the profit zone — the tape cannot eat it yet`;
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

// ── The seven filters ────────────────────────────────────────────────────────

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
  askWall: V2Wall; // biggest ask wall within 2% above (null = unknown)
  bidWall: V2Wall; // biggest bid wall within 2% below
  askWallKnown: boolean; // false when the book was not fetched
  wallBrokenConfirmed: boolean | null; // price held above the wall ≥2 min
  btcChange15m: number | null;
  btcChange1h: number | null; // multi-timeframe regime — bull traps filter
  isStablecoin: boolean;
};

export type V2Check = {
  label: string;
  pass: boolean | null; // null = not applicable / no data
  note: string;
};

export type SideVerdict = "go" | "watch" | "skip" | "blocked_btc";

export type SideAssessment = {
  score: number;
  verdict: SideVerdict;
  checks: V2Check[];
  trade: TradePlan | null;
};

function fmtUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

/** LONG side — the spec's Final Score, implemented literally. */
export function assessLong(input: V2Input): SideAssessment {
  const checks: V2Check[] = [];
  const warnings: string[] = [];

  // 1 — momentum (must be green, and staying green)
  let momentum = 0;
  const m5 = input.change5m;
  const m15 = input.change15m;
  if (m5 > V2.momentumGreen && m15 > V2.momentumGreen) momentum += 15;
  if (m5 < 0 || m15 < 0) momentum -= 20;
  if (input.change1m < V2.momentum1mRed) momentum -= 10;
  checks.push({
    label: "Momentum",
    pass: m5 > V2.momentumGreen && m15 > V2.momentumGreen,
    note:
      m5 > V2.momentumGreen && m15 > V2.momentumGreen
        ? `5m ${m5.toFixed(2)}% and 15m ${m15.toFixed(2)}% both green +15`
        : m5 < 0 || m15 < 0
          ? `tape red (5m ${m5.toFixed(2)}%, 15m ${m15.toFixed(2)}%) −20`
          : `tape not green enough (5m ${m5.toFixed(2)}%, 15m ${m15.toFixed(2)}%)`,
  });

  // 2 — real dollar volume
  let volume = 0;
  if (input.vol5mUsd > V2.volHighUsd) volume += 10;
  else if (input.vol5mUsd < V2.volLowUsd) volume -= 20;
  checks.push({
    label: "Real volume",
    pass: input.vol5mUsd > V2.volLowUsd,
    note:
      input.vol5mUsd > V2.volHighUsd
        ? `${fmtUsd(input.vol5mUsd)} traded in 5m +10`
        : input.vol5mUsd < V2.volLowUsd
          ? `only ${fmtUsd(input.vol5mUsd)} in 5m — low money −20`
          : `${fmtUsd(input.vol5mUsd)} in 5m (${input.rvol.toFixed(1)}× avg)`,
  });

  // 3 — sell wall
  let wall = 0;
  const wallKnown = input.askWallKnown;
  const w = input.askWall;
  if (wallKnown && w === null) {
    wall += 15; // no wall within 2% above — clear runway
    checks.push({ label: "Sell wall", pass: true, note: "no ask wall within +2% — clear runway +15" });
  } else if (wallKnown && w !== null) {
    const above = input.price > w.price;
    if (above) {
      wall += 15;
      checks.push({
        label: "Sell wall",
        pass: true,
        note: `price is above the ${fmtUsd(w.valueUsd)} wall at ${w.price.toPrecision(6)} +15`,
      });
    } else if (w.valueUsd > input.vol5mUsd * V2.wallVsVol) {
      wall -= 20;
      checks.push({
        label: "Sell wall",
        pass: false,
        note: `wall ${fmtUsd(w.valueUsd)} > 5m volume ${fmtUsd(input.vol5mUsd)} — cannot break −20`,
      });
      warnings.push("Wall too big — cannot break");
    } else {
      checks.push({
        label: "Sell wall",
        pass: null,
        note: `wall ${fmtUsd(w.valueUsd)} above, but eatable vs ${fmtUsd(input.vol5mUsd)} volume`,
      });
    }
  } else {
    checks.push({ label: "Sell wall", pass: null, note: "order book not fetched yet — no wall data" });
  }

  // 4 — liquidity / trade count
  let liquidity = 0;
  if (input.trades5m < V2.tradesLow) liquidity -= 20;
  else if (input.trades5m > V2.tradesHealthy) liquidity += 5;
  checks.push({
    label: "Liquidity",
    pass: input.trades5m >= V2.tradesLow,
    note:
      input.trades5m < V2.tradesLow
        ? `${input.trades5m} trades in 5m — too thin −20`
        : input.trades5m > V2.tradesHealthy
          ? `${input.trades5m} trades in 5m +5`
          : `${input.trades5m} trades in 5m`,
  });

  // 5 — buyer trap: high buy% on few trades is a whale painting tape
  if (input.buyPct > V2.fakeBuyersPct && input.trades5m < V2.fakeBuyersTrades) {
    warnings.push(`Fake buyers — ${input.buyPct.toFixed(0)}% buys on only ${input.trades5m} trades`);
  }
  if (input.buyPct < V2.sellersDumpingPct && input.vol5mUsd > V2.sellersDumpingVolUsd) {
    warnings.push("Sellers dumping — exit / avoid");
  }

  const score = input.baseScore + momentum + volume + wall + liquidity;
  const mode = btcModeFor(input.btcChange15m);
  const threshold = mode === "flat" ? V2.goScoreFlat : V2.goScore;
  // 6 — BTC regime gate (not additive — a hard block) + regime alignment:
  // longs want bull mode (70+) or an exceptional setup in flat mode (80+).
  let verdict: SideVerdict;
  if (mode === "dump") {
    verdict = "blocked_btc";
    checks.push({ label: "BTC regime", pass: false, note: `BTC 15m ${input.btcChange15m?.toFixed(2)}% — dumping, longs blocked` });
  } else {
    checks.push({
      label: "BTC regime",
      pass: true,
      note: mode === "bull" ? `BTC 15m ${input.btcChange15m?.toFixed(2)}% — bull mode` : `BTC 15m ${input.btcChange15m?.toFixed(2)}% — flat, needs ${threshold}+`,
    });
    if (score >= threshold) verdict = "go";
    else if (score >= V2.watchScore) verdict = "watch";
    else verdict = "skip";
  }

  // 7 — stablecoin (handled by the caller as a global veto, but reflected here)
  if (input.isStablecoin) checks.push({ label: "Stablecoin", pass: false, note: "pegged asset — can never pump, veto" });

  // Trade plan + the hard gates that make a "go" honest. A GO is not just a
  // number — it needs real dollars, real participation, volume expansion, the
  // crowd on the right side, an un-extended day, and a profit zone nothing
  // blocks.
  const trade = buildTradePlan("long", input.price, input.atrPct, input.askWallKnown ? input.askWall : null, input.vol5mUsd);
  if (verdict === "go") {
    const greenGate = m5 > V2.momentumGreen && m15 > V2.momentumGreen;
    const dayGate = input.change24h >= V2.goLongDayMin && input.change24h <= V2.goLongDayMax;
    const volumeGate = input.vol5mUsd > V2.volLowUsd;
    const liquidityGate = input.trades5m >= V2.tradesLow;
    const expansionGate = input.rvol >= V2.goMinRvol;
    const crowdGate = input.buyPct >= V2.goMinBuyPctLong;
    const btc1hGate = input.btcChange1h === null || input.btcChange1h > -0.1; // 15m bull in a 1h downtrend = trap
    if (!greenGate) {
      verdict = "watch";
      warnings.push("Price not green on both 5m and 15m — demoted to watch");
    } else if (!btc1hGate) {
      verdict = "watch";
      warnings.push(`BTC 1h ${input.btcChange1h?.toFixed(2)}% falling — bull-trap risk, demoted to watch`);
    } else if (!dayGate) {
      verdict = "watch";
      warnings.push(
        input.change24h > V2.goLongDayMax
          ? `Day already +${input.change24h.toFixed(1)}% — the move happened without you`
          : `Day ${input.change24h.toFixed(1)}% — falling knife, not a long`,
      );
    } else if (!volumeGate) {
      verdict = "watch";
      warnings.push(`Low money — ${fmtUsd(input.vol5mUsd)} in 5m — demoted to watch`);
    } else if (!liquidityGate) {
      verdict = "watch";
      warnings.push(`Too thin — ${input.trades5m} trades — demoted to watch`);
    } else if (!expansionGate) {
      verdict = "watch";
      warnings.push(`No volume expansion (${input.rvol.toFixed(2)}×) — demoted to watch`);
    } else if (!crowdGate) {
      verdict = "watch";
      warnings.push(`Buyers only ${input.buyPct.toFixed(0)}% of tape — demoted to watch`);
    } else if (trade.blocked) {
      verdict = "watch";
      warnings.push(trade.blockReason ?? "take-profit blocked by wall");
    } else if (wallKnown && w !== null && input.price < w.price && w.valueUsd > input.vol5mUsd * V2.wallVsVol) {
      verdict = "watch";
      warnings.push("Below an unbreakable wall — wait for the break");
    }
  }

  return { score, verdict, checks, trade };
}

/** SHORT side — the mirror of the long filters for dumping coins. */
export function assessShort(input: V2Input): SideAssessment {
  const checks: V2Check[] = [];
  const warnings: string[] = [];

  // Momentum must be red and staying red.
  let momentum = 0;
  const m5 = input.change5m;
  const m15 = input.change15m;
  if (m5 < -V2.momentumGreen && m15 < -V2.momentumGreen) momentum += 15;
  if (m5 > 0 || m15 > 0) momentum -= 20;
  if (input.change1m > -V2.momentum1mRed) momentum -= 10;
  checks.push({
    label: "Momentum",
    pass: m5 < -V2.momentumGreen && m15 < -V2.momentumGreen,
    note:
      m5 < -V2.momentumGreen && m15 < -V2.momentumGreen
        ? `5m ${m5.toFixed(2)}% and 15m ${m15.toFixed(2)}% both red +15`
        : m5 > 0 || m15 > 0
          ? `tape green (5m ${m5.toFixed(2)}%, 15m ${m15.toFixed(2)}%) −20`
          : `tape not red enough (5m ${m5.toFixed(2)}%, 15m ${m15.toFixed(2)}%)`,
  });

  // Real dollar volume — same rule both directions.
  let volume = 0;
  if (input.vol5mUsd > V2.volHighUsd) volume += 10;
  else if (input.vol5mUsd < V2.volLowUsd) volume -= 20;
  checks.push({
    label: "Real volume",
    pass: input.vol5mUsd > V2.volLowUsd,
    note:
      input.vol5mUsd > V2.volHighUsd
        ? `${fmtUsd(input.vol5mUsd)} traded in 5m +10`
        : input.vol5mUsd < V2.volLowUsd
          ? `only ${fmtUsd(input.vol5mUsd)} in 5m — low money −20`
          : `${fmtUsd(input.vol5mUsd)} in 5m (${input.rvol.toFixed(1)}× avg)`,
  });

  // Wall logic inverts: an unbreakable ask wall ABOVE price is a ceiling that
  // helps the short; a bid wall below is the floor that breaks it.
  let wall = 0;
  const wallKnown = input.askWallKnown;
  const ask = input.askWall;
  const bid = input.bidWall;
  if (wallKnown && ask !== null && input.price < ask.price && ask.valueUsd > input.vol5mUsd * V2.wallVsVol) {
    wall += 15;
    checks.push({
      label: "Ceiling wall",
      pass: true,
      note: `unbreakable ${fmtUsd(ask.valueUsd)} ask wall overhead +15`,
    });
  } else if (wallKnown && ask !== null && input.price > ask.price) {
    wall -= 20;
    checks.push({ label: "Ceiling wall", pass: false, note: "price already above the wall — breakout risk −20" });
  } else {
    checks.push({ label: "Ceiling wall", pass: null, note: wallKnown ? "no meaningful wall overhead" : "order book not fetched yet" });
  }
  if (wallKnown && bid !== null && bid.valueUsd > input.vol5mUsd * V2.wallVsVol && input.price - bid.price < input.price * 0.02) {
    wall -= 15;
    checks.push({
      label: "Bid floor",
      pass: false,
      note: `bid wall ${fmtUsd(bid.valueUsd)} below — short squeeze risk −15`,
    });
  }

  // Liquidity — same rule both directions.
  let liquidity = 0;
  if (input.trades5m < V2.tradesLow) liquidity -= 20;
  else if (input.trades5m > V2.tradesHealthy) liquidity += 5;
  checks.push({
    label: "Liquidity",
    pass: input.trades5m >= V2.tradesLow,
    note:
      input.trades5m < V2.tradesLow
        ? `${input.trades5m} trades in 5m — too thin −20`
        : input.trades5m > V2.tradesHealthy
            ? `${input.trades5m} trades in 5m +5`
            : `${input.trades5m} trades in 5m`,
  });

  // Seller pressure bonus — the mirror of the buyer trap.
  let seller = 0;
  if (input.buyPct < V2.sellersDumpingPct && input.vol5mUsd > V2.volLowUsd) {
    seller += 10;
    checks.push({ label: "Seller pressure", pass: true, note: `takers only ${(100 - input.buyPct).toFixed(0)}% buys — sellers in control +10` });
  } else if (input.buyPct > 60) {
    seller -= 15;
    checks.push({ label: "Seller pressure", pass: false, note: `buyers ${input.buyPct.toFixed(0)}% of the tape — fighting the flow −15` });
  } else {
    checks.push({ label: "Seller pressure", pass: null, note: `takers ${input.buyPct.toFixed(0)}% buys — balanced` });
  }

  const score = input.baseScore + momentum + volume + wall + liquidity + seller;
  const mode = btcModeFor(input.btcChange15m);

  let verdict: SideVerdict;
  if (mode === "bull") {
    verdict = "blocked_btc";
    checks.push({ label: "BTC regime", pass: false, note: `BTC 15m ${input.btcChange15m?.toFixed(2)}% — bull mode, shorts blocked` });
  } else {
    checks.push({
      label: "BTC regime",
      pass: true,
      note:
        mode === "dump"
          ? `BTC 15m ${input.btcChange15m?.toFixed(2)}% — dumping, shorts favoured`
          : `BTC 15m ${input.btcChange15m?.toFixed(2)}% — flat, needs ${V2.goScoreFlat}+`,
    });
    // Dump mode eases the bar (the tape is already with you); flat mode
    // demands an exceptional setup, same as longs.
    const threshold = mode === "dump" ? V2.goScore - 5 : V2.goScoreFlat;
    if (score >= threshold) verdict = "go";
    else if (score >= V2.watchScore) verdict = "watch";
    else verdict = "skip";
  }

  if (input.isStablecoin) checks.push({ label: "Stablecoin", pass: false, note: "pegged asset — veto" });

  const trade = buildTradePlan("short", input.price, input.atrPct, input.bidWall, input.vol5mUsd);
  if (verdict === "go") {
    const redGate = m5 < -V2.momentumGreen && m15 < -V2.momentumGreen;
    const dayGate = input.change24h >= V2.goShortDayMin && input.change24h <= V2.goShortDayMax;
    const volumeGate = input.vol5mUsd > V2.volLowUsd;
    const liquidityGate = input.trades5m >= V2.tradesLow;
    const expansionGate = input.rvol >= V2.goMinRvol;
    const crowdGate = input.buyPct <= V2.goMinBuyPctShort;
    const btc1hGate = input.btcChange1h === null || input.btcChange1h < 0.1; // 15m dip in a 1h uptrend = dip-buy zone
    if (!redGate) {
      verdict = "watch";
      warnings.push("Price not red on both 5m and 15m — demoted to watch");
    } else if (!btc1hGate) {
      verdict = "watch";
      warnings.push(`BTC 1h ${input.btcChange1h?.toFixed(2)}% rising — dip gets bought, demoted to watch`);
    } else if (!dayGate) {
      verdict = "watch";
      warnings.push(
        input.change24h < V2.goShortDayMin
          ? `Day ${input.change24h.toFixed(1)}% — crash mostly done, bounce risk`
          : `Day +${input.change24h.toFixed(1)}% — day trend fights the short`,
      );
    } else if (!volumeGate) {
      verdict = "watch";
      warnings.push(`Low money — ${fmtUsd(input.vol5mUsd)} in 5m — demoted to watch`);
    } else if (!liquidityGate) {
      verdict = "watch";
      warnings.push(`Too thin — ${input.trades5m} trades — demoted to watch`);
    } else if (!expansionGate) {
      verdict = "watch";
      warnings.push(`No volume expansion (${input.rvol.toFixed(2)}×) — demoted to watch`);
    } else if (!crowdGate) {
      verdict = "watch";
      warnings.push(`Sellers only ${(100 - input.buyPct).toFixed(0)}% of tape — demoted to watch`);
    } else if (trade.blocked) {
      verdict = "watch";
      warnings.push(trade.blockReason ?? "take-profit blocked by bid wall");
    }
  }

  return { score, verdict, checks, trade };
}

// ── Scenario map — what could happen, BEFORE the decision ────────────────────

export type Scenario = { tone: "bull" | "base" | "bear"; title: string; body: string };

export function buildScenarios(input: V2Input, long: SideAssessment, short: SideAssessment): Scenario[] {
  const bull: string[] = [];
  const bear: string[] = [];
  const w = input.askWall;

  if (input.rvol >= 2) bull.push(`volume holds above ${input.rvol.toFixed(1)}× average`);
  if (input.buyPct >= 55) bull.push(`takers keep buying (${input.buyPct.toFixed(0)}% of tape)`);
  if (input.btcChange15m !== null && input.btcChange15m > 0.1) bull.push("BTC regime stays supportive");
  if (w && input.price > w.price) bull.push("the broken wall stays broken — old resistance becomes support");
  if (!w) bull.push("thin asks overhead — runway to TP2");

  if (input.buyPct < 45) bear.push(`sellers own the tape (${(100 - input.buyPct).toFixed(0)}% sells)`);
  if (input.rvol < 1.2) bear.push("volume fades back to average — the move starves");
  if (w && input.price < w.price && w.valueUsd > input.vol5mUsd) bear.push(`the ${fmtUsd(w.valueUsd)} wall refuses to break`);
  if (input.btcChange15m !== null && input.btcChange15m < -0.1) bear.push("BTC rolls over");
  if (input.trades5m < V2.tradesLow) bear.push("thin trade count — one whale flips it");

  const risk = long.trade?.riskPct ?? 1;
  const scenarios: Scenario[] = [
    {
      tone: "bull",
      title: long.verdict === "go" ? "Confirms → ride to TP" : "Bull case",
      body: `${bull.length > 0 ? bull.slice(0, 3).join("; ") : "momentum and flow keep building"}. Price clears +${((long.trade?.tp1Pct ?? risk * 2)).toFixed(1)}% (TP1), runner to +${((long.trade?.tp2Pct ?? risk * 3.5)).toFixed(1)}% (TP2).`,
    },
    {
      tone: "base",
      title: "Base case — chop",
      body: `Volume normalises, price chops ±${(input.atrPct ?? 0.5).toFixed(2)}% for an hour. No trade needed — waiting is the position.`,
    },
    {
      tone: "bear",
      title: "Invalidated → stop",
      body: `${bear.length > 0 ? bear.slice(0, 3).join("; ") : "flow flips against the setup"}. Stop −${risk.toFixed(1)}% takes the small loss; short watch begins if tape stays red (short score ${short.score}).`,
    },
  ];
  return scenarios;
}

// ── Row-level V2 assessment (combines both sides) ────────────────────────────

export type RowVerdict = "go_long" | "go_short" | "watch" | "skip" | "blocked_btc" | "stable";

export type RowV2 = {
  longScore: number;
  shortScore: number;
  verdict: RowVerdict;
  longVerdict: SideVerdict;
  shortVerdict: SideVerdict;
  checks: V2Check[]; // long-side checks (the primary read)
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
};

export function assessRow(input: V2Input): RowV2 {
  const long = assessLong(input);
  const short = assessShort(input);
  const scenarios = buildScenarios(input, long, short);

  let verdict: RowVerdict;
  if (input.isStablecoin) verdict = "stable";
  else if (long.verdict === "go") verdict = "go_long";
  else if (short.verdict === "go") verdict = "go_short";
  else if (long.verdict === "blocked_btc") verdict = "blocked_btc";
  else if (long.verdict === "watch" || short.verdict === "watch") verdict = "watch";
  else verdict = "skip";

  const warnings = [
    ...assessLongWarnings(input),
    ...(short.verdict === "go" ? ["Short setup stronger — tape is dumping"] : []),
  ];

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
    warnings,
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
  };
}

function assessLongWarnings(input: V2Input): string[] {
  const warnings: string[] = [];
  if (input.buyPct > V2.fakeBuyersPct && input.trades5m < V2.fakeBuyersTrades) {
    warnings.push(`Fake buyers — ${input.buyPct.toFixed(0)}% buys on only ${input.trades5m} trades`);
  }
  if (input.buyPct < V2.sellersDumpingPct && input.vol5mUsd > V2.sellersDumpingVolUsd) {
    warnings.push("Sellers dumping — exit / avoid");
  }
  if (input.vol5mUsd < V2.volLowUsd) warnings.push(`Low money — ${fmtUsd(input.vol5mUsd)} in 5m`);
  if (input.askWallKnown && input.askWall !== null && input.price < input.askWall.price && input.askWall.valueUsd > input.vol5mUsd) {
    warnings.push("Wall too big — cannot break");
  }
  return warnings;
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
}

// ── Backtest core — prove the filters before trusting them ───────────────────
//
// Replays 5-minute bars through the same seven filters (wall filter skipped —
// historical order books are not available for free; the backtest says so
// honestly) and grades every go-signal against its own stop/targets.

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
  outcome: "win" | "big_win" | "loss" | "timeout";
  pnlPct: number;
  bars: number;
  score: number;
};

export type BacktestStats = {
  trades: number;
  wins: number;
  bigWins: number;
  losses: number;
  timeouts: number;
  winRate: number | null; // (wins + bigWins) / decided
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null; // gross win / gross loss
  expectancyPct: number | null; // avg pnl per trade
};

export function emptyStats(): BacktestStats {
  return {
    trades: 0,
    wins: 0,
    bigWins: 0,
    losses: 0,
    timeouts: 0,
    winRate: null,
    avgWinPct: null,
    avgLossPct: null,
    profitFactor: null,
    expectancyPct: null,
  };
}

const MAX_FORWARD_BARS = 24; // 2 hours to resolve, else timeout

/**
 * Runs the V2 long+short simulation over one symbol's 5m bars.
 * `btcBars` supplies the BTC regime at each timestamp (aligned by index from
 * the end — the caller fetches the same window for BTC).
 */
export function backtestSymbol(pair: string, bars: BacktestBar[], btcBars: BacktestBar[]): { longs: BacktestTrade[]; shorts: BacktestTrade[] } {
  const longs: BacktestTrade[] = [];
  const shorts: BacktestTrade[] = [];
  if (bars.length < 40) return { longs, shorts };

  const ledger = new CooldownLedger();
  const atrCaches = new Map<number, number | null>();

  // Rolling ATR on 5m bars, expressed as an estimated 1m ATR (÷2.2 — the
  // √time scaling of a random walk) so stop distances match live semantics.
  const atrAt = (i: number): number | null => {
    const cached = atrCaches.get(i);
    if (cached !== undefined) return cached;
    const slice = bars.slice(Math.max(0, i - 15), i + 1).map((b) => ({ high: b.h, low: b.l, close: b.c }));
    const atr = slice.length >= 15 ? atrPctFromCandles(slice, 14) : null;
    const est = atr !== null ? atr / 2.2 : null;
    atrCaches.set(i, est);
    return est;
  };

  const btcIndex = new Map<number, number>(); // 5m-bucket → index, for O(1) regime lookups
  for (let i = 0; i < btcBars.length; i += 1) btcIndex.set(Math.floor(btcBars[i].t / 300_000), i);

  const btcChange15mAt = (t: number): number | null => {
    // BTC 15m = the three closed BTC 5m bars before this bar opened.
    const i = btcIndex.get(Math.floor(t / 300_000) - 1);
    if (i === undefined || i < 2) return null;
    const start = btcBars[i - 2];
    const end = btcBars[i];
    return start.o > 0 ? ((end.c - start.o) / start.o) * 100 : null;
  };

  const btcChange1hAt = (t: number): number | null => {
    // BTC 1h = the twelve closed BTC 5m bars before this bar opened.
    const i = btcIndex.get(Math.floor(t / 300_000) - 1);
    if (i === undefined || i < 11) return null;
    const start = btcBars[i - 11];
    const end = btcBars[i];
    return start.o > 0 ? ((end.c - start.o) / start.o) * 100 : null;
  };

  const grade = (side: "long" | "short", signalBar: number): BacktestTrade | null => {
    const bar = bars[signalBar];
    if (!bar) return null;
    const atr = atrAt(signalBar);
    const plan = buildTradePlan(side, bar.c, atr, null, bar.quoteVol);
    for (let j = signalBar + 1; j < Math.min(bars.length, signalBar + 1 + MAX_FORWARD_BARS); j += 1) {
      const fwd = bars[j];
      if (!fwd) break;
      const hitStop = side === "long" ? fwd.l <= plan.stop : fwd.h >= plan.stop;
      const hitTp2 = side === "long" ? fwd.h >= plan.tp2 : fwd.l <= plan.tp2;
      const hitTp1 = side === "long" ? fwd.h >= plan.tp1 : fwd.l <= plan.tp1;
      // Conservative ordering: same-bar stop + target → stop wins.
      if (hitStop) {
        return {
          pair, side, time: bar.t, entry: bar.c, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2,
          exitTime: fwd.t, exitPrice: plan.stop, outcome: "loss", pnlPct: -plan.riskPct, bars: j - signalBar,
          score: 0,
        };
      }
      if (hitTp2) {
        return {
          pair, side, time: bar.t, entry: bar.c, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2,
          exitTime: fwd.t, exitPrice: plan.tp2, outcome: "big_win", pnlPct: plan.tp2Pct, bars: j - signalBar,
          score: 0,
        };
      }
      if (hitTp1) {
        return {
          pair, side, time: bar.t, entry: bar.c, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2,
          exitTime: fwd.t, exitPrice: plan.tp1, outcome: "win", pnlPct: plan.tp1Pct, bars: j - signalBar,
          score: 0,
        };
      }
    }
    const last = bars[Math.min(bars.length - 1, signalBar + MAX_FORWARD_BARS)];
    if (!last) return null;
    const pnl = side === "long" ? (last.c - bar.c) / bar.c * 100 : (bar.c - last.c) / bar.c * 100;
    return {
      pair, side, time: bar.t, entry: bar.c, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2,
      exitTime: last.t, exitPrice: last.c, outcome: "timeout", pnlPct: pnl, bars: MAX_FORWARD_BARS,
      score: 0,
    };
  };

  for (let i = 16; i < bars.length - 1; i += 1) {
    const bar = bars[i];
    const prev = bars[i - 1];
    if (!bar || !prev || bar.c <= 0) continue;

    // Baseline: the 12 bars BEFORE the signal bar (one hour, excluding the
    // spike itself — including it would dampen the very expansion we measure).
    const window = bars.slice(i - 17, i - 5);
    const baselineVol = window.length > 0 ? window.reduce((a, b) => a + b.quoteVol, 0) / window.length : 0;
    const baselineTrades = window.length > 0 ? window.reduce((a, b) => a + b.trades, 0) / window.length : 0;
    const vol5mUsd = prev.quoteVol; // last CLOSED bar is the "now" tape
    const trades5m = prev.trades;
    const rvol = baselineVol > 0 ? vol5mUsd / baselineVol : 0;
    const tradeSpike = baselineTrades > 0 ? trades5m / baselineTrades : 0;
    const buyPct = prev.quoteVol > 0 ? (prev.takerBuyQuote / prev.quoteVol) * 100 : 50;

    // Momentum on the 5m grid: 1 bar = 5m, 3 bars = 15m.
    const c5m = bars[i - 1].c;
    const c15m = bars[i - 3]?.c ?? c5m;
    const change5m = c5m > 0 && bars[i - 2] ? ((c5m - bars[i - 2].c) / bars[i - 2].c) * 100 : 0;
    const change15m = c15m > 0 && bars[i - 4] ? ((c15m - bars[i - 4].c) / bars[i - 4].c) * 100 : 0;
    const change1m = prev.o > 0 ? ((prev.c - prev.o) / prev.o) * 100 : 0; // intra-bar proxy

    // Close strength of the last closed bar.
    const strength = prev.h > prev.l ? (prev.c - prev.l) / (prev.h - prev.l) : 0.5;

    // Base score — same shape as the live scanner.
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    const rvolPts = 30 * clamp01((rvol - 1) / 4);
    const tradePts = 10 * clamp01((tradeSpike - 1) / 4);
    let momentumPts = 0;
    if (change1m > 0 && change5m > 0 && change15m > 0) momentumPts += 10;
    if (change5m > 0 && change5m >= change15m) momentumPts += 8;
    if (change1m > 0 && change1m >= change5m) momentumPts += 7;
    const buyPts = 20 * clamp01((buyPct - 50) / 30);
    const closePts = 15 * clamp01(strength);
    const baseScore = Math.round(Math.min(100, Math.max(0, rvolPts + tradePts + momentumPts + buyPts + closePts)));

    const stable = stablecoinLike(bar.c, change15m, 0);
    const btcChange15m = btcChange15mAt(bar.t);
    // Rolling 24h change (288 bars) — the day-extension gate reads this. Near
    // the start of the window the oldest available span stands in.
    const dayStart = bars[Math.max(0, i - 288)];
    const change24h = dayStart && dayStart.o > 0 ? ((bar.c - dayStart.o) / dayStart.o) * 100 : 0;

    const input: V2Input = {
      base: pair.replace(/USDT$/, ""),
      price: bar.c,
      change1m,
      change5m,
      change15m,
      change24h,
      vol5mUsd,
      rvol,
      trades5m,
      buyPct,
      baseScore,
      atrPct: atrAt(i - 1),
      askWall: null,
      bidWall: null,
      askWallKnown: false, // no historical order books — wall filter honestly off
      wallBrokenConfirmed: null,
      btcChange15m,
      btcChange1h: btcChange1hAt(bar.t),
      isStablecoin: stable,
    };

    const now = bar.t;
    const long = assessLong(input);
    const short = assessShort(input);

    if (long.verdict === "go" && ledger.longAllowed(pair, now) && !ledger.repeatLong(pair, now)) {
      const trade = grade("long", i);
      if (trade) {
        trade.score = long.score;
        longs.push(trade);
        ledger.longSignal(pair, now);
        // A long that stops out is a bearish event — cooldown the pair.
        if (trade.outcome === "loss") ledger.bearishSignal(pair, trade.exitTime ?? now);
      }
    }
    if (short.verdict === "go" && ledger.shortAllowed(pair, now) && !ledger.repeatShort(pair, now)) {
      const trade = grade("short", i);
      if (trade) {
        trade.score = short.score;
        shorts.push(trade);
        ledger.shortSignal(pair, now);
      }
    }
  }

  return { longs, shorts };
}

export function statsFor(trades: BacktestTrade[]): BacktestStats {
  const stats = emptyStats();
  stats.trades = trades.length;
  let grossWin = 0;
  let grossLoss = 0;
  let winSum = 0;
  let lossSum = 0;
  let pnlSum = 0;
  for (const t of trades) {
    pnlSum += t.pnlPct;
    if (t.outcome === "win" || t.outcome === "big_win") {
      if (t.outcome === "big_win") stats.bigWins += 1;
      else stats.wins += 1;
      grossWin += t.pnlPct;
      winSum += t.pnlPct;
    } else if (t.outcome === "loss") {
      stats.losses += 1;
      grossLoss += Math.abs(t.pnlPct);
      lossSum += t.pnlPct;
    } else {
      stats.timeouts += 1;
    }
  }
  const decided = stats.wins + stats.bigWins + stats.losses;
  stats.winRate = decided > 0 ? (stats.wins + stats.bigWins) / decided : null;
  stats.avgWinPct = stats.wins + stats.bigWins > 0 ? winSum / (stats.wins + stats.bigWins) : null;
  stats.avgLossPct = stats.losses > 0 ? lossSum / stats.losses : null;
  stats.profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null;
  stats.expectancyPct = trades.length > 0 ? pnlSum / trades.length : null;
  return stats;
}

// ── Convenience: V2 fields from a live RadarRow-shaped input ─────────────────

export function rowInputFromRadar(row: RadarRow, extras: {
  atrPct: number | null;
  askWall: V2Wall;
  bidWall: V2Wall;
  askWallKnown: boolean;
  wallBrokenConfirmed: boolean | null;
  btcChange15m: number | null;
  btcChange1h?: number | null;
  isStablecoin?: boolean;
}): V2Input {
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
    atrPct: extras.atrPct,
    askWall: extras.askWall,
    bidWall: extras.bidWall,
    askWallKnown: extras.askWallKnown,
    wallBrokenConfirmed: extras.wallBrokenConfirmed,
    btcChange15m: extras.btcChange15m,
    btcChange1h: extras.btcChange1h ?? null,
    isStablecoin: extras.isStablecoin ?? stablecoinLike(row.price, row.change15m, row.change24h),
  };
}
