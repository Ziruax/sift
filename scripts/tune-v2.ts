// V2.1 parameter tuner — the honest "tune the numbers" loop.
//
// Fetches real 5m candles once (top pairs + BTC), then replays the exact V2.1
// engine (three-axis score, ATR-normalized gates, partial exits, fees) over a
// grid of threshold combinations by mutating the runtime V2 object, and ranks
// configurations by NET expectancy in R × trade count — the audit's target
// (expectancy × opportunity), NOT raw win rate — with a minimum decided-trade
// floor and a Wilson 95% CI printed for the finalists.
//
// Run: bun scripts/tune-v2.ts [days] [coins]

import { V2, backtestSymbol, statsFor, wilsonCi, type BacktestBar, type BacktestTrade } from "../src/lib/market/v2-engine";
import { isJunkBase } from "../src/lib/market/baseline";

const REST_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

const DAYS = Number(process.argv[2] ?? 14);
const COINS = Number(process.argv[3] ?? 20);
const TOTAL_BARS = DAYS * 288;

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function restFetch(path: string, timeoutMs = 15_000): Promise<unknown> {
  let lastError: unknown = null;
  for (const host of REST_HOSTS) {
    try {
      const response = await fetch(host + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`Binance responded ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Binance unreachable");
}

async function fetchBars(pair: string): Promise<BacktestBar[]> {
  const collected: BacktestBar[] = [];
  let endTime = Date.now();
  while (collected.length < TOTAL_BARS) {
    const payload = await restFetch(`/api/v3/klines?symbol=${pair}&interval=5m&limit=1000&endTime=${endTime}`);
    if (!Array.isArray(payload) || payload.length === 0) break;
    const batch: BacktestBar[] = (payload as unknown[][]).map((k) => ({
      t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]),
      quoteVol: num(k[7]), trades: num(k[8]), takerBuyQuote: num(k[10]),
    }));
    collected.unshift(...batch);
    endTime = batch[0].t - 1;
    if (payload.length < 1000) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return collected;
}

type Combo = {
  goScore: number;
  flatDelta: number; // goScoreFlat = goScore + flatDelta
  goMinRvol: number;
  momentumAtrMult: number;
  tp1Mult: number;
};

const GRID: Combo[] = [];
for (const goScore of [45, 50, 55, 60, 65]) {
  for (const flatDelta of [0, 7]) {
    for (const goMinRvol of [1.5, 2.0, 2.5]) {
      for (const momentumAtrMult of [0.35, 0.5]) {
        for (const tp1Mult of [1.5, 2.0]) {
          GRID.push({ goScore, flatDelta, goMinRvol, momentumAtrMult, tp1Mult });
        }
      }
    }
  }
}

const DEFAULTS = { ...V2 } as Record<string, number>;

type SideStat = { trades: number; decided: number; hits: number; losses: number; pnlNet: number; riskSum: number; riskN: number };

function sideStat(trades: BacktestTrade[]): SideStat {
  const s: SideStat = { trades: trades.length, decided: 0, hits: 0, losses: 0, pnlNet: 0, riskSum: 0, riskN: 0 };
  for (const t of trades) {
    s.pnlNet += t.pnlNetPct;
    if (t.entry > 0 && t.stop > 0) {
      s.riskSum += Math.abs((t.entry - t.stop) / t.entry) * 100;
      s.riskN += 1;
    }
    if (t.outcome === "loss") {
      s.losses += 1;
      s.decided += 1;
    } else if (t.outcome === "win" || t.outcome === "big_win" || t.outcome === "be") {
      s.hits += 1;
      s.decided += 1;
    }
  }
  return s;
}

async function main() {
  console.log(`Loading top ${COINS} pairs (fixed blacklist, top-by-volume pool — slight survivorship bias acknowledged)…`);
  const payload = await restFetch("/api/v3/ticker/24hr", 20_000);
  const pairs = (payload as Array<{ symbol?: unknown; quoteVolume?: unknown }>)
    .filter((row) => {
      const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : "";
      if (!symbol.endsWith("USDT") || symbol === "BTCUSDT") return false;
      const base = symbol.slice(0, -4);
      if (!base || isJunkBase(base)) return false;
      return num(row.quoteVolume) > 0;
    })
    .sort((a, b) => num(b.quoteVolume) - num(a.quoteVolume))
    .slice(0, COINS)
    .map((r) => String(r.symbol).toUpperCase());

  const btcBars = await fetchBars("BTCUSDT");
  console.log(`BTC bars: ${btcBars.length}`);
  const barsByPair = new Map<string, BacktestBar[]>();
  for (const pair of pairs) {
    const bars = await fetchBars(pair);
    barsByPair.set(pair, bars);
    process.stdout.write(".");
  }
  console.log(`\nLoaded ${barsByPair.size} pairs × ~${TOTAL_BARS} bars (${DAYS} days). Simulating ${GRID.length} combos…\n`);

  type Row = { combo: Combo; l: SideStat; s: SideStat };
  const results: Row[] = [];
  for (const combo of GRID) {
    const V = V2 as unknown as Record<string, number>;
    V.goScore = combo.goScore;
    V.goScoreFlat = combo.goScore + combo.flatDelta;
    V.goScoreShortDump = Math.max(30, combo.goScore - 5);
    V.watchScore = Math.max(20, combo.goScore - 13);
    V.goMinRvol = combo.goMinRvol;
    V.momentumAtrMult = combo.momentumAtrMult;
    V.tp1Mult = combo.tp1Mult;
    V.tp2Mult = combo.tp1Mult * 1.75;

    let longs: BacktestTrade[] = [];
    let shorts: BacktestTrade[] = [];
    for (const [pair, bars] of barsByPair) {
      const r = backtestSymbol(pair, bars, btcBars);
      longs = longs.concat(r.longs);
      shorts = shorts.concat(r.shorts);
    }
    results.push({ combo, l: sideStat(longs), s: sideStat(shorts) });
    process.stdout.write("#");
  }

  // Restore defaults before exiting (paranoia — separate process anyway).
  for (const [k, v] of Object.entries(DEFAULTS)) (V2 as unknown as Record<string, number>)[k] = v;

  const describe = (x: SideStat): string => {
    const wr = x.decided > 0 ? x.hits / x.decided : null;
    const exp = x.trades > 0 ? x.pnlNet / x.trades : null;
    const avgRisk = x.riskN > 0 ? x.riskSum / x.riskN : null;
    const expR = exp !== null && avgRisk !== null && avgRisk > 0 ? exp / avgRisk : null;
    const ci = wr !== null ? wilsonCi(x.hits, x.decided) : null;
    return (
      `WR ${wr === null ? "—" : `${(wr * 100).toFixed(0)}%${ci ? ` (${(ci.lo * 100).toFixed(0)}–${(ci.hi * 100).toFixed(0)})` : ""}`} · ` +
      `${x.hits}W/${x.losses}L/${x.trades - x.decided}T · exp ${exp === null ? "—" : `${exp >= 0 ? "+" : ""}${exp.toFixed(2)}%`} · ` +
      `${expR === null ? "—" : `${expR >= 0 ? "+" : ""}${expR.toFixed(2)}R`} · total ${expR !== null && x.trades > 0 ? (expR * x.trades).toFixed(0) : "—"}R`
    );
  };

  console.log("\n\n── LONG configs (min 40 decided), ranked by net expectancy-R × trades ──");
  results
    .filter((r) => r.l.decided >= 40)
    .sort((a, b) => {
      const er = (x: SideStat) => (x.trades > 0 && x.riskN > 0 ? (x.pnlNet / x.trades) / (x.riskSum / x.riskN) * x.trades : -99);
      return er(b.l) - er(a.l);
    })
    .slice(0, 12)
    .forEach((r) => {
      console.log(`go>${r.combo.goScore} flat+${r.combo.flatDelta} rvol>${r.combo.goMinRvol} mom×${r.combo.momentumAtrMult} tp${r.combo.tp1Mult}× | ${describe(r.l)}`);
    });

  console.log("\n── SHORT configs (min 25 decided), ranked by net expectancy-R × trades ──");
  results
    .filter((r) => r.s.decided >= 25)
    .sort((a, b) => {
      const er = (x: SideStat) => (x.trades > 0 && x.riskN > 0 ? (x.pnlNet / x.trades) / (x.riskSum / x.riskN) * x.trades : -99);
      return er(b.s) - er(a.s);
    })
    .slice(0, 12)
    .forEach((r) => {
      console.log(`go>${r.combo.goScore} flat+${r.combo.flatDelta} rvol>${r.combo.goMinRvol} mom×${r.combo.momentumAtrMult} tp${r.combo.tp1Mult}× | ${describe(r.s)}`);
    });

  console.log("\n── COMBINED (long+short net R total, min 60 decided) ──");
  results
    .filter((r) => r.l.decided + r.s.decided >= 60)
    .map((r) => {
      const er = (x: SideStat) => (x.trades > 0 && x.riskN > 0 ? (x.pnlNet / x.trades) / (x.riskSum / x.riskN) * x.trades : 0);
      return { combo: r.combo, total: er(r.l) + er(r.s), l: r.l, s: r.s };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .forEach((r) => {
      console.log(`total ${r.total.toFixed(0)}R | L: ${describe(r.l)} | S: ${describe(r.s)} | go>${r.combo.goScore} flat+${r.combo.flatDelta} rvol>${r.combo.goMinRvol} mom×${r.combo.momentumAtrMult} tp${r.combo.tp1Mult}×`);
    });

  // Honest calibration note for the finalists.
  console.log(`
── Reminder ──
14 days is one regime. With ~150 trades the 95% CI on a 55% win rate is ±8%.
Anything within ±0.15R of zero is indistinguishable from noise at this sample
size. Pick the config whose CI excludes zero, not the point estimate's peak.
The wall filter is OFF in this replay, so live will fire fewer, stricter
signals than these numbers suggest.`);
}

void main();
