// V2 parameter tuner — the honest "tune the numbers" loop.
//
// Fetches real 5m candles once (top pairs + BTC), then replays the exact
// engine over a grid of threshold combinations by mutating the runtime V2
// object, and ranks configurations by expectancy with a minimum trade count.
// Run: bun scripts/tune-v2.ts [days] [coins]

import { V2, backtestSymbol, statsFor, type BacktestBar } from "../src/lib/market/v2-engine";

const REST_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
const STABLE_BASES = new Set(["USDT", "USDC", "FDUSD", "DAI", "TUSD", "USDP", "BUSD", "BFUSD", "USDS"]);
const FIAT_BASES = new Set(["EUR", "GBP", "BRL", "AUD", "TRY", "NGN", "UAH", "ARS", "MXN", "ZAR", "PLN", "CZK", "HUF", "ILS"]);
const PEGGED_BASES = new Set(["RLUSD", "USD1", "USDE", "USD0", "PYUSD", "EURC", "USDD", "FRAX", "LUSD", "GUSD", "XUSD", "RWUSD", "XAUT", "PAXG"]);

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
  momentumGreen: number;
  goMinRvol: number;
  goScoreFlat: number;
  tp1Mult: number;
};

const GRID: Combo[] = [];
for (const momentumGreen of [0.2, 0.3, 0.4]) {
  for (const goMinRvol of [1.5, 2, 2.5]) {
    for (const goScoreFlat of [80, 85, 95]) {
      for (const tp1Mult of [1.5, 2]) {
        GRID.push({ momentumGreen, goMinRvol, goScoreFlat, tp1Mult });
      }
    }
  }
}

const DEFAULTS = { ...V2 } as Record<string, number>;

async function main() {
  console.log(`Loading top ${COINS} pairs…`);
  const payload = await restFetch("/api/v3/ticker/24hr", 20_000);
  const pairs = (payload as Array<{ symbol?: unknown; quoteVolume?: unknown }>)
    .filter((row) => {
      const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : "";
      if (!symbol.endsWith("USDT")) return false;
      const base = symbol.slice(0, -4);
      if (!base || STABLE_BASES.has(base) || FIAT_BASES.has(base) || PEGGED_BASES.has(base)) return false;
      if (/^(.{2,4})(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
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
    process.stdout.write(`.`);
  }
  console.log(`\nLoaded ${barsByPair.size} pairs × ~${TOTAL_BARS} bars (${DAYS} days). Tuning…\n`);

  const results: Array<{ combo: Combo; longs: ReturnType<typeof statsFor>; shorts: ReturnType<typeof statsFor> }> = [];
  for (const combo of GRID) {
    // Mutate the runtime thresholds (V2 is a plain object at runtime).
    (V2 as unknown as Record<string, number>).momentumGreen = combo.momentumGreen;
    (V2 as unknown as Record<string, number>).goMinRvol = combo.goMinRvol;
    (V2 as unknown as Record<string, number>).goScoreFlat = combo.goScoreFlat;
    (V2 as unknown as Record<string, number>).tp1Mult = combo.tp1Mult;
    (V2 as unknown as Record<string, number>).tp2Mult = combo.tp1Mult * 1.75;

    let longTrades = 0, longWins = 0, longLosses = 0, longPnl = 0;
    let shortTrades = 0, shortWins = 0, shortLosses = 0, shortPnl = 0;
    for (const [pair, bars] of barsByPair) {
      const { longs, shorts } = backtestSymbol(pair, bars, btcBars);
      const ls = statsFor(longs);
      const ss = statsFor(shorts);
      longTrades += ls.trades; longWins += ls.wins + ls.bigWins; longLosses += ls.losses; longPnl += longs.reduce((a, t) => a + t.pnlPct, 0);
      shortTrades += ss.trades; shortWins += ss.wins + ss.bigWins; shortLosses += ss.losses; shortPnl += shorts.reduce((a, t) => a + t.pnlPct, 0);
    }
    results.push({
      combo,
      longs: { trades: longTrades, wins: longWins, losses: longLosses, winRate: longWins + longLosses > 0 ? longWins / (longWins + longLosses) : null, expectancy: longTrades > 0 ? longPnl / longTrades : null } as ReturnType<typeof statsFor>,
      shorts: { trades: shortTrades, wins: shortWins, losses: shortLosses, winRate: shortWins + shortLosses > 0 ? shortWins / (shortWins + shortLosses) : null, expectancy: shortTrades > 0 ? shortPnl / shortTrades : null } as ReturnType<typeof statsFor>,
    });
    process.stdout.write("#");
  }

  // Restore defaults before exiting (paranoia — separate process anyway).
  for (const [k, v] of Object.entries(DEFAULTS)) (V2 as unknown as Record<string, number>)[k] = v;

  console.log("\n\n── LONG configs (min 40 decided trades), ranked by expectancy ──");
  results
    .filter((r) => r.longs.wins + r.longs.losses >= 40)
    .sort((a, b) => (b.longs.expectancy ?? -99) - (a.longs.expectancy ?? -99))
    .slice(0, 10)
    .forEach((r) => {
      console.log(
        `exp ${(r.longs.expectancy ?? 0).toFixed(2)}% | WR ${((r.longs.winRate ?? 0) * 100).toFixed(0)}% (${r.longs.wins}W/${r.longs.losses}L/${r.longs.trades - r.longs.wins - r.longs.losses}T) | mom>${r.combo.momentumGreen} rvol>${r.combo.goMinRvol} flat>${r.combo.goScoreFlat} tp${r.combo.tp1Mult}×`,
      );
    });

  console.log("\n── SHORT configs (min 30 decided trades), ranked by expectancy ──");
  results
    .filter((r) => r.shorts.wins + r.shorts.losses >= 30)
    .sort((a, b) => (b.shorts.expectancy ?? -99) - (a.shorts.expectancy ?? -99))
    .slice(0, 10)
    .forEach((r) => {
      console.log(
        `exp ${(r.shorts.expectancy ?? 0).toFixed(2)}% | WR ${((r.shorts.winRate ?? 0) * 100).toFixed(0)}% (${r.shorts.wins}W/${r.shorts.losses}L/${r.shorts.trades - r.shorts.wins - r.shorts.losses}T) | mom>${r.combo.momentumGreen} rvol>${r.combo.goMinRvol} flat>${r.combo.goScoreFlat} tp${r.combo.tp1Mult}×`,
      );
    });

  console.log("\n── COMBINED (long+short expectancy, min 60 decided) ──");
  results
    .filter((r) => r.longs.wins + r.longs.losses + r.shorts.wins + r.shorts.losses >= 60)
    .map((r) => {
      const trades = r.longs.trades + r.shorts.trades;
      const exp = (((r.longs.expectancy ?? 0) * r.longs.trades) + ((r.shorts.expectancy ?? 0) * r.shorts.trades)) / (trades || 1);
      return { combo: r.combo, exp, trades, l: r.longs, s: r.shorts };
    })
    .sort((a, b) => b.exp - a.exp)
    .slice(0, 10)
    .forEach((r) => {
      console.log(
        `exp ${r.exp.toFixed(2)}% | L: WR ${((r.l.winRate ?? 0) * 100).toFixed(0)}% of ${r.l.trades} | S: WR ${((r.s.winRate ?? 0) * 100).toFixed(0)}% of ${r.s.trades} | mom>${r.combo.momentumGreen} rvol>${r.combo.goMinRvol} flat>${r.combo.goScoreFlat} tp${r.combo.tp1Mult}×`,
      );
    });
}

void main();
