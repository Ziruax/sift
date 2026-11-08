"use client";

// ── Backtest — prove the V2 filters on real history before trusting them ─────
//
// Runs entirely in the browser: fetches 5-minute candles straight from
// Binance's public API for the top-volume pairs plus BTC, replays them through
// the exact same engine the live radar uses (via backtestSymbol), and grades
// every go-signal against its own stop and take-profits — with fees and
// slippage on every trade, partial exits at TP1 with a breakeven runner, a
// shadow log of every gate veto, and a Wilson 95% CI on the win rate.
//
// Two honest limitations, stated up front:
//   • Historical order books are not free, so the wall filter is off in the
//     replay — the live engine adds it, which can only reject more setups,
//     never invent wins.
//   • The candidate pool is today's top-120 by volume, but the ranking inside
//     it uses each pair's volume AS OF the window start (point-in-time) — the
//     honest compromise on survivorship.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FlaskConical, Play, RotateCcw, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPrice } from "@/lib/market/format";
import { isJunkBase } from "@/lib/market/baseline";
import * as LocalRadar from "@/lib/market/local-radar";
import {
  backtestSymbol,
  buildCalibration,
  emptyStats,
  gateEfficacy,
  statsFor,
  wilsonCi,
  type BacktestBar,
  type BacktestStats,
  type BacktestTrade,
  type Calibration,
  type GateEfficacy,
  type ShadowEntry,
} from "@/lib/market/v2-engine";

const REST_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
const DAYS_OPTIONS = [14, 30, 90] as const;
const COINS_OPTIONS = [10, 20, 30] as const;
const CANDIDATE_POOL = 120; // today's top-120 by volume — the survivorship compromise
const CALIBRATION_KEY = "sift:calibration:v1";

type Phase = "idle" | "running" | "done" | "error";

type CoinResult = {
  pair: string;
  base: string;
  bars: number;
  longs: BacktestTrade[];
  shorts: BacktestTrade[];
};

type Result = {
  ranAt: string;
  days: number;
  coins: number;
  perCoin: CoinResult[];
  allLongs: BacktestTrade[];
  allShorts: BacktestTrade[];
  shadow: ShadowEntry[];
  calibration: Calibration;
};

// The browser engine (local-radar) exposes the live veto log as
// getLocalShadowSignals(): ShadowLogEntry[]. It may not exist yet while that
// half of the V2.1 work lands — read it defensively so this panel simply
// doesn't render until it does.
type LiveShadowEntry = { pair: string; side: "long" | "short"; gate: string; at: string; price: number; change60m: number | null };

function readLiveShadow(): LiveShadowEntry[] {
  try {
    const api = LocalRadar as unknown as { getLocalShadowSignals?: () => LiveShadowEntry[] };
    const entries = api.getLocalShadowSignals?.();
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

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

/**
 * Point-in-time universe (§6 survivorship fix): rank by each pair's 24h quote
 * volume AS OF the backtest window start, not today's. The candidate pool is
 * still today's top-120 by volume (no free all-pairs historical volume
 * endpoint exists) — the honest compromise, stated in the UI. One daily
 * kline per candidate carries that day's quote volume (field k[7]).
 */
async function topPairsPointInTime(limit: number, days: number, onProbe?: (probed: number, total: number) => void): Promise<string[]> {
  const payload = await restFetch("/api/v3/ticker/24hr", 20_000);
  if (!Array.isArray(payload)) throw new Error("Unexpected ticker payload");
  const rows = (payload as Array<{ symbol?: unknown; quoteVolume?: unknown }>)
    .filter((row) => {
      const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : "";
      if (!symbol.endsWith("USDT")) return false;
      if (symbol === "BTCUSDT") return false; // fetched separately — never in the ranked list
      if (isJunkBase(symbol.slice(0, -4))) return false;
      return num(row.quoteVolume) > 0;
    })
    .sort((a, b) => num(b.quoteVolume) - num(a.quoteVolume))
    .slice(0, CANDIDATE_POOL);

  const windowStartMs = Date.now() - days * 86_400_000;
  const measured: Array<{ symbol: string; vol: number }> = [];
  for (let i = 0; i < rows.length; i += 1) {
    const symbol = String(rows[i].symbol).toUpperCase();
    try {
      const kline = await restFetch(`/api/v3/klines?symbol=${symbol}&interval=1d&limit=1&endTime=${windowStartMs}`, 15_000);
      if (Array.isArray(kline) && kline.length > 0) {
        const vol = num((kline[0] as unknown[])[7]);
        if (vol > 0) measured.push({ symbol, vol });
      }
    } catch {
      // candidate unreachable — skip it; the pool has ~119 others
    }
    onProbe?.(i + 1, rows.length);
    await new Promise((r) => setTimeout(r, 120)); // pace — stay friendly to the weight window
  }
  measured.sort((a, b) => b.vol - a.vol);
  return measured.slice(0, limit).map((m) => m.symbol);
}

/** 5m bars, oldest→newest, fetched 1000 at a time walking backwards. */
async function fetchBars(pair: string, totalBars: number, onChunk?: () => void): Promise<BacktestBar[]> {
  const collected: BacktestBar[] = [];
  let endTime = Date.now();
  while (collected.length < totalBars) {
    const payload = await restFetch(
      `/api/v3/klines?symbol=${pair}&interval=5m&limit=1000&endTime=${endTime}`,
      15_000,
    );
    if (!Array.isArray(payload) || payload.length === 0) break;
    const batch: BacktestBar[] = (payload as unknown[][]).map((k) => ({
      t: num(k[0]),
      o: num(k[1]),
      h: num(k[2]),
      l: num(k[3]),
      c: num(k[4]),
      quoteVol: num(k[7]),
      trades: num(k[8]),
      takerBuyQuote: num(k[10]),
    }));
    collected.unshift(...batch);
    endTime = batch[0].t - 1;
    onChunk?.();
    if (payload.length < 1000) break;
    await new Promise((r) => setTimeout(r, 120)); // pace — stay friendly to the weight window
  }
  return collected;
}

/** Gross view of net-scored trades: feed pnlPct into the net stats pipeline. */
function grossify(trades: BacktestTrade[]): BacktestTrade[] {
  return trades.map((t) => ({ ...t, pnlNetPct: t.pnlPct }));
}

export function BacktestView() {
  const [days, setDays] = useState<(typeof DAYS_OPTIONS)[number]>(14);
  const [coins, setCoins] = useState<(typeof COINS_OPTIONS)[number]>(20);
  const [net, setNet] = useState(true); // fees toggle — ON by default
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ label: "", pct: 0 });
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calPersisted, setCalPersisted] = useState<boolean | null>(null);
  const [liveShadow, setLiveShadow] = useState<LiveShadowEntry[]>([]);
  const running = useRef(false);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase("running");
    setError(null);
    setResult(null);
    setCalPersisted(null);
    try {
      const totalBars = days * 288;
      const steps = coins + 1;
      let done = 0;
      const tick = (label: string) => {
        done += 1;
        setProgress({ label, pct: Math.min(100, 30 + Math.round((done / steps) * 70)) });
      };

      // §6 survivorship fix — rank by volume as of the window start.
      setProgress({ label: "Ranking the market by volume…", pct: 2 });
      const pairs = await topPairsPointInTime(coins, days, (probed, total) => {
        setProgress({ label: `Measuring point-in-time volume — candidate ${probed}/${total}…`, pct: 2 + Math.round((probed / total) * 28) });
      });
      if (pairs.length === 0) throw new Error("No tradable pairs came back from Binance.");

      // BTC first — its regime gates every other symbol's longs/shorts.
      const btcBars = await fetchBars("BTCUSDT", totalBars);
      tick("BTC candles loaded");

      const perCoin: CoinResult[] = [];
      const allLongs: BacktestTrade[] = [];
      const allShorts: BacktestTrade[] = [];
      const shadow: ShadowEntry[] = [];
      for (const pair of pairs) {
        setProgress({ label: `Replaying ${pair.replace(/USDT$/, "")}…`, pct: Math.min(100, 30 + Math.round((done / steps) * 70)) });
        const bars = await fetchBars(pair, totalBars);
        if (bars.length >= 60) {
          const { longs, shorts, shadow: pairShadow } = backtestSymbol(pair, bars, btcBars);
          perCoin.push({ pair, base: pair.replace(/USDT$/, ""), bars: bars.length, longs, shorts });
          allLongs.push(...longs);
          allShorts.push(...shorts);
          shadow.push(...pairShadow);
        }
        tick(pair);
      }

      // §8 — persist this window's empirical hit rates for the live radar.
      const calibration = buildCalibration([...allLongs, ...allShorts], days, perCoin.length);
      let persisted = false;
      try {
        window.localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
        persisted = true;
      } catch {
        persisted = false;
      }
      setCalPersisted(persisted);

      setResult({
        ranAt: new Date().toISOString(),
        days,
        coins: perCoin.length,
        perCoin,
        allLongs,
        allShorts,
        shadow,
        calibration,
      });
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The backtest failed to run.");
      setPhase("error");
    } finally {
      running.current = false;
    }
  }, [days, coins]);

  // Live veto log from the running browser engine — polled while results show.
  useEffect(() => {
    if (phase !== "done") return;
    const read = () => setLiveShadow(readLiveShadow());
    read();
    const id = setInterval(read, 30_000);
    return () => clearInterval(id);
  }, [phase]);

  // Everything below recomputes when the fees toggle flips — cheap (a few
  // hundred trades at most).
  const view = useMemo(() => {
    if (!result) return null;
    const perCoinStats = result.perCoin.map((c) => ({
      pair: c.pair,
      base: c.base,
      bars: c.bars,
      longs: statsFor(net ? c.longs : grossify(c.longs)),
      shorts: statsFor(net ? c.shorts : grossify(c.shorts)),
    }));
    return {
      perCoinStats,
      longs: aggregate(perCoinStats.map((c) => c.longs)),
      shorts: aggregate(perCoinStats.map((c) => c.shorts)),
      recent: [...result.allLongs, ...result.allShorts].sort((a, b) => b.time - a.time).slice(0, 40),
      gates: gateEfficacy(result.shadow),
    };
  }, [result, net]);

  const halfRows = useMemo(() => {
    if (!result) return [] as HalfRow[];
    const stat = (ts: BacktestTrade[]) => statsFor(net ? ts : grossify(ts));
    const split = (ts: BacktestTrade[]): { first: BacktestTrade[]; second: BacktestTrade[] } | null => {
      if (ts.length === 0) return null;
      const times = ts.map((t) => t.time).sort((a, b) => a - b);
      const mid = times[Math.floor(times.length / 2)];
      return { first: ts.filter((t) => t.time < mid), second: ts.filter((t) => t.time >= mid) };
    };
    const sets: Array<{ key: string; label: string; trades: BacktestTrade[] }> = [
      { key: "all", label: "All (longs + shorts)", trades: [...result.allLongs, ...result.allShorts] },
      { key: "long", label: "Longs", trades: result.allLongs },
      { key: "short", label: "Shorts", trades: result.allShorts },
    ];
    return sets.map((s) => {
      const halves = split(s.trades);
      if (!halves) return { key: s.key, label: s.label, first: null, second: null, drift: false };
      const first = stat(halves.first);
      const second = stat(halves.second);
      const drift = first.winRate !== null && second.winRate !== null && Math.abs(first.winRate - second.winRate) > 0.15;
      return { key: s.key, label: s.label, first, second, drift };
    });
  }, [result, net]);

  const anyDrift = halfRows.some((r) => r.drift);

  const liveGateRows = useMemo(() => {
    if (liveShadow.length < 5) return [] as LiveGateRow[];
    const byGate = new Map<string, LiveShadowEntry[]>();
    for (const e of liveShadow) {
      const list = byGate.get(e.gate) ?? [];
      list.push(e);
      byGate.set(e.gate, list);
    }
    const rows: LiveGateRow[] = [];
    for (const [gate, list] of byGate) {
      const decided = list.filter((e) => e.change60m !== null) as Array<LiveShadowEntry & { change60m: number }>;
      const hits = decided.filter((e) => (e.side === "long" ? e.change60m > 0 : e.change60m < 0)).length;
      rows.push({
        gate,
        blocked: list.length,
        decided: decided.length,
        hits,
        hitRate: decided.length > 0 ? hits / decided.length : null,
        avgPnl: decided.length > 0 ? decided.reduce((a, e) => a + (e.side === "long" ? e.change60m : -e.change60m), 0) / decided.length : null,
      });
    }
    rows.sort((a, b) => b.blocked - a.blocked);
    return rows;
  }, [liveShadow]);

  const verdict = (stats: BacktestStats): { label: string; tone: "up" | "warn" | "down"; icon: typeof CheckCircle2 } => {
    const decided = stats.wins + stats.bigWins + stats.be + stats.losses;
    const expR = stats.expectancyR;
    if (decided === 0 || expR === null) return { label: "No decided trades", tone: "warn", icon: AlertTriangle };
    // Honest calibration (audit): trust the expectancy in R, not the raw win
    // rate — and only call an edge "worth trusting" on a real sample.
    let label: string;
    let tone: "up" | "warn" | "down";
    if (expR >= 0.3) {
      label = "Edge worth trusting";
      tone = decided >= 100 ? "up" : "warn";
    } else if (expR >= 0.1) {
      label = "Thin edge — costs will eat it";
      tone = "warn";
    } else if (expR >= 0) {
      label = "No measurable edge";
      tone = "warn";
    } else {
      label = "Negative expectancy";
      tone = "down";
    }
    if (decided < 100) label += " (sample too small to distinguish from noise — need 1000+ trades for real confidence)";
    return { label, tone, icon: tone === "up" ? CheckCircle2 : AlertTriangle };
  };

  const calibrationBins = result?.calibration.bins ?? [];
  const showCalibrationTable = calibrationBins.some((b) => b.n >= 30);

  return (
    <div className="space-y-4">
      <section aria-label="What is this" className="rounded-xl border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <FlaskConical className="size-4 text-up" aria-hidden="true" />
          Backtest — the proof before the promise
        </h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Replays the exact same V2 engine the live radar uses over days of real 5-minute Binance candles,
          in your browser — including the <strong>stateful verdict layer</strong> (V2.2): a GO fires only
          when the smoothed score confirms over consecutive bars and dwells, and leaves only through the
          hysteresis exit, exactly like the live scanner. Every <strong>go long</strong> / <strong>go short</strong> it
          would have fired is graded
          against its own ATR-sized stop and take-profits: half the position comes off at TP1 (+2× risk), the stop
          moves to breakeven — the <strong>BE</strong> outcome is exactly that, TP1 then breakeven — and the runner
          targets TP2 (+3.5× risk). Same-bar collisions count as losses — conservative on purpose — and a 2-hour
          time stop exits anything still open. Numbers are <strong>net of a 0.25% round-trip cost</strong> by default
          (toggle below for gross). The thresholds were tuned by grid search over this same history; re-run any
          window to keep them honest.
        </p>
        <p className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-warn/30 bg-transparent px-2.5 py-1.5 text-[11px] text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Two honest limitations: historical order books are not free, so the wall filter is off in the replay (the
          live engine adds it — it can only reject more setups, never invent wins). And the universe is ranked by
          volume as of the window start (point-in-time), from today&rsquo;s top-120 pool — the honest compromise on
          survivorship.
        </p>
      </section>

      {/* Controls */}
      <section className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <label className="text-xs">
          <span className="block text-muted-foreground">History</span>
          <div className="mt-1 flex gap-1">
            {DAYS_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                aria-pressed={days === d}
                className={cn(
                  "min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors",
                  days === d ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                {d} days
              </button>
            ))}
          </div>
          {days === 90 && <span className="mt-1 block text-[10px] text-muted-foreground">≈ 5 minutes of fetching</span>}
        </label>
        <label className="text-xs">
          <span className="block text-muted-foreground">Coins (top by volume at window start)</span>
          <div className="mt-1 flex gap-1">
            {COINS_OPTIONS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCoins(c)}
                aria-pressed={coins === c}
                className={cn(
                  "min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors",
                  coins === c ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </label>
        <label className="text-xs">
          <span className="block text-muted-foreground">Costs</span>
          <div className="mt-1 flex gap-1">
            <button
              type="button"
              onClick={() => setNet((v) => !v)}
              aria-pressed={net}
              title="When on, every trade is charged the 0.25% round-trip (taker fees + slippage) before it counts"
              className={cn(
                "min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors",
                net ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              Net of fees (0.25% round-trip)
            </button>
          </div>
        </label>
        <button
          type="button"
          onClick={() => void run()}
          disabled={phase === "running"}
          className="ml-auto inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
        >
          {phase === "running" ? <RotateCcw className="size-4 animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
          {phase === "running" ? "Running…" : `Run ${days}-day backtest`}
        </button>
      </section>

      {/* Progress */}
      {phase === "running" && (
        <section aria-live="polite" className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">{progress.label}</span>
            <span className="num font-mono text-muted-foreground">{progress.pct}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-up transition-[width] duration-300" style={{ width: `${progress.pct}%` }} />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Fetching candles straight from Binance&rsquo;s public API, paced to stay inside the rate limit — a 30-day ×
            30-coin run takes about a minute; 90 days ≈ 5 minutes of fetching.
          </p>
        </section>
      )}

      {phase === "error" && (
        <section className="rounded-xl border border-down/40 bg-down-soft px-4 py-3 text-sm text-down">{error}</section>
      )}

      {/* Results */}
      {phase === "done" && result && view && (
        <>
          <section className="grid gap-3 sm:grid-cols-2" aria-label="Backtest summary">
            <StatBlock title="Go long" side="long" stats={view.longs} verdict={verdict(view.longs)} mode={net ? "net" : "gross"} />
            <StatBlock title="Go short" side="short" stats={view.shorts} verdict={verdict(view.shorts)} mode={net ? "net" : "gross"} />
          </section>

          {/* §8 calibration write */}
          <section className="rounded-xl border border-border bg-card p-4" aria-label="Calibration">
            <h3 className="text-sm font-semibold">Calibration</h3>
            {calPersisted ? (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-up">
                <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
                Calibration saved — the live radar now labels signals with this window&rsquo;s empirical hit rates.
              </p>
            ) : (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-warn">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                Calibration computed, but browser storage refused it — the live radar kept its previous calibration.
              </p>
            )}
            {showCalibrationTable && (
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th scope="col" className="py-2 pr-2 font-medium">Score band</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">n</th>
                    <th scope="col" className="py-2 text-right font-medium">Hit rate</th>
                  </tr>
                </thead>
                <tbody>
                  {calibrationBins.map((b, i) => {
                    const band = i < calibrationBins.length - 1 ? `${b.scoreMin}–${calibrationBins[i + 1].scoreMin - 1}` : `${b.scoreMin}+`;
                    const small = b.n < 30;
                    return (
                      <tr key={b.scoreMin} className="border-b border-border/60 last:border-0">
                        <td className={cn("num py-2 pr-2 font-mono text-xs", small ? "text-muted-foreground" : "font-semibold")} title={small ? "n < 30 — too few trades to trust this band" : undefined}>
                          {band}
                        </td>
                        <td className={cn("num px-2 py-2 text-right font-mono text-xs", small && "text-muted-foreground")}>{b.n}</td>
                        <td className="py-2 text-right">
                          <WrCell wr={b.decided > 0 ? b.hitRate : null} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          {/* §6 walk-forward sanity */}
          <section className="overflow-hidden rounded-xl border border-border bg-card" aria-label="Walk-forward sanity">
            <div className="border-b border-border px-4 py-2.5">
              <h3 className="text-sm font-semibold">Walk-forward sanity</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                First half vs second half of the window, split at each set&rsquo;s median time. An edge that vanishes in
                the second half was regime luck, not signal.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th scope="col" className="py-2.5 pl-4 pr-2 font-medium">Side</th>
                    <th scope="col" className="px-2 py-2.5 text-right font-medium">1st-half WR</th>
                    <th scope="col" className="px-2 py-2.5 text-right font-medium">1st-half exp</th>
                    <th scope="col" className="px-2 py-2.5 text-right font-medium">2nd-half WR</th>
                    <th scope="col" className="px-2 py-2.5 pr-4 text-right font-medium">2nd-half exp</th>
                  </tr>
                </thead>
                <tbody>
                  {halfRows.map((r) => (
                    <tr key={r.key} className="border-b border-border/60 last:border-0">
                      <td className="py-2.5 pl-4 pr-2 font-semibold">
                        {r.label}
                        {r.drift && (
                          <span className="ml-1.5 text-warn" title="the halves disagree by more than 15 win-rate points" aria-label="in-sample drift">
                            ⚠
                          </span>
                        )}
                      </td>
                      <td className="num px-2 py-2.5 text-right font-mono text-xs">
                        <WrCell wr={r.first?.winRate ?? null} />
                      </td>
                      <td className="num px-2 py-2.5 text-right font-mono text-xs">
                        <ExpCell value={r.first?.expectancyPct ?? null} />
                      </td>
                      <td className="num px-2 py-2.5 text-right font-mono text-xs">
                        <WrCell wr={r.second?.winRate ?? null} />
                      </td>
                      <td className="num px-2 py-2.5 pr-4 text-right font-mono text-xs">
                        <ExpCell value={r.second?.expectancyPct ?? null} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {anyDrift && (
              <p className="flex items-start gap-1.5 border-t border-warn/30 px-4 py-2.5 text-[11px] text-warn">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                In-sample drift — the second half disagrees with the first; treat the full-window numbers with suspicion.
              </p>
            )}
          </section>

          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
              <h3 className="text-sm font-semibold">Per-coin results</h3>
              <span className="num rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {result.coins} coins · {result.days} days · ran {new Date(result.ranAt).toLocaleTimeString([], { hour12: false })} · {net ? "net of fees" : "gross"}
              </span>
            </div>
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th scope="col" className="py-2.5 pl-4 pr-2 font-medium">Coin</th>
                    <th scope="col" className="px-2 py-2.5 text-right font-medium">Longs</th>
                    <th scope="col" className="px-2 py-2.5 text-right font-medium">Long WR</th>
                    <th scope="col" className="px-2 py-2.5 text-right font-medium">Shorts</th>
                    <th scope="col" className="px-2 py-2.5 text-right font-medium">Short WR</th>
                    <th scope="col" className="px-2 py-2.5 text-right font-medium" title={net ? "net expectancy per long trade" : "gross expectancy per long trade"}>Exp. long</th>
                    <th scope="col" className="hidden px-2 py-2.5 pr-4 text-right font-medium md:table-cell">Bars</th>
                  </tr>
                </thead>
                <tbody>
                  {view.perCoinStats.map((c) => (
                    <tr key={c.pair} className="border-b border-border/60 last:border-0">
                      <td className="py-2.5 pl-4 pr-2 font-semibold">{c.base}</td>
                      <td className="num px-2 py-2.5 text-right font-mono text-xs">{c.longs.trades}</td>
                      <td className="num px-2 py-2.5 text-right font-mono text-xs">
                        <WrCell wr={c.longs.winRate} />
                      </td>
                      <td className="num px-2 py-2.5 text-right font-mono text-xs">{c.shorts.trades}</td>
                      <td className="num px-2 py-2.5 text-right font-mono text-xs">
                        <WrCell wr={c.shorts.winRate} />
                      </td>
                      <td className="num px-2 py-2.5 text-right font-mono text-xs">
                        <ExpCell value={c.longs.expectancyPct} />
                      </td>
                      <td className="num hidden px-2 py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground md:table-cell">{c.bars}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* §6 gate efficacy — the single cheapest accuracy tool */}
          {view.gates.length > 0 && (
            <section className="overflow-hidden rounded-xl border border-border bg-card" aria-label="Gate efficacy">
              <div className="border-b border-border px-4 py-2.5">
                <h3 className="text-sm font-semibold">Gate efficacy — what each veto is actually blocking</h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Every would-be go-signal a gate rejected is shadow-graded against the same stop and targets. A veto
                  blocking a set that would have won is a gate costing you money.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th scope="col" className="py-2.5 pl-4 pr-2 font-medium">Gate</th>
                      <th scope="col" className="px-2 py-2.5 text-right font-medium">Blocked</th>
                      <th scope="col" className="px-2 py-2.5 text-right font-medium">Would-be hit rate</th>
                      <th scope="col" className="px-2 py-2.5 text-right font-medium">Would-be avg net P&amp;L</th>
                      <th scope="col" className="py-2.5 pl-2 pr-4 font-medium">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.gates.map((g) => {
                      const v = gateVerdict(g);
                      return (
                        <tr key={g.gate} className="border-b border-border/60 last:border-0">
                          <td className="py-2.5 pl-4 pr-2 font-semibold">{g.gate}</td>
                          <td className="num px-2 py-2.5 text-right font-mono text-xs">{g.blocked}</td>
                          <td className="num px-2 py-2.5 text-right font-mono text-xs">
                            {g.hitRate !== null ? `${(g.hitRate * 100).toFixed(0)}%` : "—"}
                          </td>
                          <td className="num px-2 py-2.5 text-right font-mono text-xs">
                            {g.avgPnlNet !== null ? (
                              <span className={g.avgPnlNet > 0 ? "text-up" : g.avgPnlNet < 0 ? "text-down" : "text-muted-foreground"}>
                                {g.avgPnlNet >= 0 ? "+" : ""}
                                {g.avgPnlNet.toFixed(2)}%
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className={cn("py-2.5 pl-2 pr-4 text-[11px] font-medium", v.tone)}>{v.text}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Live veto log — only when the browser engine has been running */}
              {liveShadow.length >= 5 && (
                <div className="border-t border-border">
                  <div className="px-4 py-2.5">
                    <h4 className="text-xs font-semibold">Live veto log (from the running scanner)</h4>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      What the in-browser engine has vetoed since it started, graded ±% at 60 minutes.
                    </p>
                  </div>
                  <div className="max-h-72 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-card">
                        <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                          <th scope="col" className="py-2.5 pl-4 pr-2 font-medium">Pair</th>
                          <th scope="col" className="px-2 py-2.5 font-medium">Side</th>
                          <th scope="col" className="px-2 py-2.5 font-medium">Gate</th>
                          <th scope="col" className="px-2 py-2.5 font-medium">When</th>
                          <th scope="col" className="py-2.5 pl-2 pr-4 text-right font-medium">±% at 60m</th>
                        </tr>
                      </thead>
                      <tbody>
                        {liveShadow
                          .slice()
                          .reverse()
                          .map((e, i) => (
                            <tr key={`${e.pair}-${e.at}-${i}`} className="border-b border-border/60 last:border-0">
                              <td className="py-2.5 pl-4 pr-2 font-semibold">{e.pair.replace(/USDT$/, "")}</td>
                              <td className="px-2 py-2.5">
                                <span className={cn("text-xs font-semibold", e.side === "long" ? "text-up" : "text-down")}>{e.side}</span>
                              </td>
                              <td className="px-2 py-2.5 text-xs">{e.gate}</td>
                              <td className="num px-2 py-2.5 font-mono text-xs text-muted-foreground" title={e.at}>
                                {new Date(e.at).toLocaleTimeString([], { hour12: false })}
                              </td>
                              <td className="num py-2.5 pl-2 pr-4 text-right font-mono text-xs">
                                {e.change60m === null ? (
                                  <span className="text-muted-foreground" title="outcome pending — entry under 60 minutes old">
                                    pending
                                  </span>
                                ) : (
                                  <span className={e.change60m > 0 ? "text-up" : e.change60m < 0 ? "text-down" : "text-muted-foreground"}>
                                    {e.change60m >= 0 ? "+" : ""}
                                    {e.change60m.toFixed(2)}%
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  {liveGateRows.length > 0 && (
                    <div className="overflow-x-auto border-t border-border/60">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                            <th scope="col" className="py-2.5 pl-4 pr-2 font-medium">Gate</th>
                            <th scope="col" className="px-2 py-2.5 text-right font-medium">Blocked</th>
                            <th scope="col" className="px-2 py-2.5 text-right font-medium">Would-be hit rate</th>
                            <th scope="col" className="py-2.5 pl-2 pr-4 text-right font-medium">Avg ±%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {liveGateRows.map((g) => (
                            <tr key={g.gate} className="border-b border-border/60 last:border-0">
                              <td className="py-2.5 pl-4 pr-2 font-semibold">{g.gate}</td>
                              <td className="num px-2 py-2.5 text-right font-mono text-xs">{g.blocked}</td>
                              <td className="num px-2 py-2.5 text-right font-mono text-xs">
                                {g.hitRate !== null ? `${(g.hitRate * 100).toFixed(0)}%` : "—"}
                              </td>
                              <td className="num py-2.5 pl-2 pr-4 text-right font-mono text-xs">
                                {g.avgPnl !== null ? (
                                  <span className={g.avgPnl > 0 ? "text-up" : g.avgPnl < 0 ? "text-down" : "text-muted-foreground"}>
                                    {g.avgPnl >= 0 ? "+" : ""}
                                    {g.avgPnl.toFixed(2)}%
                                  </span>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4 py-2.5">
              <h3 className="text-sm font-semibold">Most recent simulated trades</h3>
            </div>
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th scope="col" className="py-2.5 pl-4 pr-2 font-medium">Time</th>
                    <th scope="col" className="px-2 py-2.5 font-medium">Coin</th>
                    <th scope="col" className="px-2 py-2.5 font-medium">Side</th>
                    <th scope="col" className="px-2 py-2.5 text-right font-medium">Entry</th>
                    <th scope="col" className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">Stop / TP1 / TP2</th>
                    <th scope="col" className="px-2 py-2.5 font-medium">Outcome</th>
                    <th scope="col" className="px-2 py-2.5 text-right font-medium" title={net ? "net of fees + slippage" : "gross, before fees"}>P&amp;L</th>
                    <th scope="col" className="hidden px-2 py-2.5 pr-4 text-right font-medium md:table-cell">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {view.recent.map((t, i) => {
                    const pnl = net ? t.pnlNetPct : t.pnlPct;
                    return (
                      <tr key={`${t.pair}-${t.time}-${i}`} className="border-b border-border/60 last:border-0">
                        <td className="num py-2.5 pl-4 pr-2 font-mono text-xs text-muted-foreground">
                          {new Date(t.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
                        </td>
                        <td className="px-2 py-2.5 font-semibold">{t.pair.replace(/USDT$/, "")}</td>
                        <td className="px-2 py-2.5">
                          <span className={cn("inline-flex items-center gap-1 text-xs font-semibold", t.side === "long" ? "text-up" : "text-down")}>
                            {t.side === "long" ? <TrendingUp className="size-3" aria-hidden="true" /> : <TrendingDown className="size-3" aria-hidden="true" />}
                            {t.side}
                          </span>
                        </td>
                        <td className="num px-2 py-2.5 text-right font-mono text-xs">{formatPrice(t.entry)}</td>
                        <td className="num hidden px-2 py-2.5 text-right font-mono text-[11px] text-muted-foreground sm:table-cell">
                          {formatPrice(t.stop)} / {formatPrice(t.tp1)} / {formatPrice(t.tp2)}
                        </td>
                        <td className="px-2 py-2.5">
                          <span
                            title={t.outcome === "be" ? "TP1→BE — partial at TP1, runner stopped at breakeven" : undefined}
                            className={cn(
                              "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                              t.outcome === "win" && "border-up/40 bg-up-soft text-up",
                              t.outcome === "big_win" && "border-up/50 bg-up-soft text-up font-bold",
                              t.outcome === "be" && "border-warn/40 bg-warn-soft text-warn",
                              t.outcome === "loss" && "border-down/40 bg-down-soft text-down",
                              t.outcome === "timeout" && "border-border bg-muted text-muted-foreground",
                            )}
                          >
                            {t.outcome === "big_win" ? "TP2" : t.outcome === "win" ? "TP1" : t.outcome === "be" ? "BE" : t.outcome === "loss" ? "stopped" : "timeout"}
                          </span>
                        </td>
                        <td className="num px-2 py-2.5 text-right font-mono text-xs">
                          <span className={pnl > 0 ? "text-up" : pnl < 0 ? "text-down" : "text-muted-foreground"}>
                            {pnl >= 0 ? "+" : ""}
                            {pnl.toFixed(2)}%
                          </span>
                        </td>
                        <td className="num hidden px-2 py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground md:table-cell">{t.score}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {phase === "idle" && (
        <section className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <p className="text-sm font-medium">No backtest run yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
            Pick a window and press Run. Everything happens locally from Binance&rsquo;s public candle history — no
            keys, no server, nothing leaves your browser. The point is simple: a net expectancy of +0.30R or better
            on hundreds of decided trades earns trust; near zero or below, the thresholds need tuning.
          </p>
        </section>
      )}
    </div>
  );
}

// ── Aggregation — per-coin stats → side totals, weighted by trade counts ─────
//
// Rebuilds the exact numbers statsFor would produce over the pooled trades:
// counts sum, averages re-weight by their denominators, the win-rate CI is a
// fresh Wilson interval on the aggregated counts, and expectancyR is the
// trade-weighted expectancy divided by the trade-weighted avg risk.

function aggregate(stats: BacktestStats[]): BacktestStats {
  const out = emptyStats();
  let winSum = 0,
    winCount = 0,
    lossSum = 0,
    lossCount = 0,
    grossWin = 0,
    grossLoss = 0;
  let expectancyWeighted = 0,
    expectancyBase = 0,
    riskWeighted = 0,
    riskBase = 0;
  for (const s of stats) {
    out.trades += s.trades;
    out.wins += s.wins;
    out.bigWins += s.bigWins;
    out.be += s.be;
    out.losses += s.losses;
    out.timeouts += s.timeouts;
    const hits = s.wins + s.bigWins + s.be;
    if (s.avgWinPct !== null) {
      winSum += s.avgWinPct * hits;
      winCount += hits;
      grossWin += s.avgWinPct * hits;
    }
    if (s.avgLossPct !== null) {
      lossSum += s.avgLossPct * s.losses;
      lossCount += s.losses;
      grossLoss += Math.abs(s.avgLossPct) * s.losses;
    }
    if (s.expectancyPct !== null) {
      expectancyWeighted += s.expectancyPct * s.trades;
      expectancyBase += s.trades;
    }
    if (s.avgRiskPct !== null) {
      riskWeighted += s.avgRiskPct * s.trades;
      riskBase += s.trades;
    }
  }
  const hits = out.wins + out.bigWins + out.be;
  const decided = hits + out.losses;
  out.winRate = decided > 0 ? hits / decided : null;
  out.winRateCi = decided > 0 ? wilsonCi(hits, decided) : null;
  out.avgWinPct = winCount > 0 ? winSum / winCount : null;
  out.avgLossPct = lossCount > 0 ? lossSum / lossCount : null;
  out.profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null;
  out.expectancyPct = expectancyBase > 0 ? expectancyWeighted / expectancyBase : null;
  out.avgRiskPct = riskBase > 0 ? riskWeighted / riskBase : null;
  out.expectancyR =
    out.expectancyPct !== null && out.avgRiskPct !== null && out.avgRiskPct > 0 ? out.expectancyPct / out.avgRiskPct : null;
  out.totalTrades = out.trades;
  return out;
}

type HalfRow = {
  key: string;
  label: string;
  first: BacktestStats | null;
  second: BacktestStats | null;
  drift: boolean;
};

type LiveGateRow = {
  gate: string;
  blocked: number;
  decided: number;
  hits: number;
  hitRate: number | null;
  avgPnl: number | null;
};

function gateVerdict(g: GateEfficacy): { text: string; tone: string } {
  if (g.hitRate === null || g.avgPnlNet === null) {
    return { text: "Not enough decided outcomes to judge yet", tone: "text-muted-foreground" };
  }
  if (g.hitRate >= 0.55 && g.avgPnlNet > 0) {
    return { text: "This gate is COSTING you winners — investigate loosening it", tone: "text-warn" };
  }
  if (g.hitRate <= 0.4 || g.avgPnlNet < 0) {
    return { text: "Gate is doing its job", tone: "text-up" };
  }
  return { text: "Neutral", tone: "text-muted-foreground" };
}

function WrCell({ wr }: { wr: number | null }) {
  if (wr === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={wr >= 0.65 ? "font-bold text-up" : wr >= 0.55 ? "text-up" : wr >= 0.5 ? "text-warn" : "text-down"}>
      {(wr * 100).toFixed(0)}%
    </span>
  );
}

function ExpCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return <span className={value > 0 ? "text-up" : value < 0 ? "text-down" : "text-muted-foreground"}>{`${value >= 0 ? "+" : ""}${value.toFixed(2)}%`}</span>;
}

function StatBlock({
  title,
  side,
  stats,
  verdict,
  mode,
}: {
  title: string;
  side: "long" | "short";
  stats: BacktestStats;
  verdict: { label: string; tone: "up" | "warn" | "down"; icon: typeof CheckCircle2 };
  mode: "net" | "gross";
}) {
  const Icon = verdict.icon;
  const hits = stats.wins + stats.bigWins + stats.be;
  const decided = hits + stats.losses;
  const ci = stats.winRateCi;
  return (
    <div className={cn("rounded-xl border p-4", side === "long" ? "border-up/30 bg-up-soft/30" : "border-down/30 bg-down-soft/30")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={cn("text-sm font-semibold", side === "long" ? "text-up" : "text-down")}>
          {title}
          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">{mode === "net" ? "net of fees" : "gross"}</span>
        </h3>
        <span className={cn("flex items-center gap-1 text-[11px] font-medium", verdict.tone === "up" ? "text-up" : verdict.tone === "warn" ? "text-warn" : "text-down")}>
          <Icon className="size-3.5" aria-hidden="true" />
          {verdict.label}
        </span>
      </div>
      <p className="num mt-2 font-mono text-3xl font-bold leading-none">
        {stats.winRate !== null ? `${(stats.winRate * 100).toFixed(0)}%` : "—"}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {ci ? `(95% CI ${Math.round(ci.lo * 100)}–${Math.round(ci.hi * 100)}, n=${decided})` : decided > 0 ? `(n=${decided})` : ""}{" "}
          win rate · {hits}W / {stats.losses}L / {stats.timeouts}T of {stats.trades}
        </span>
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Avg win</dt>
          <dd className="num font-mono text-up">{stats.avgWinPct !== null ? `+${stats.avgWinPct.toFixed(2)}%` : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Avg loss</dt>
          <dd className="num font-mono text-down">{stats.avgLossPct !== null ? `${stats.avgLossPct.toFixed(2)}%` : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Profit factor</dt>
          <dd className="num font-mono">{stats.profitFactor !== null && Number.isFinite(stats.profitFactor) ? `${stats.profitFactor.toFixed(2)}×` : stats.profitFactor === Infinity ? "∞" : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Expectancy</dt>
          <dd className={cn("num font-mono", (stats.expectancyPct ?? 0) > 0 ? "text-up" : "text-down")}>
            {stats.expectancyPct !== null ? `${stats.expectancyPct >= 0 ? "+" : ""}${stats.expectancyPct.toFixed(2)}%` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground" title="net expectancy in units of average risk">
            Expectancy (R)
          </dt>
          <dd className={cn("num font-mono", (stats.expectancyR ?? 0) > 0 ? "text-up" : "text-down")}>
            {stats.expectancyR !== null ? `${stats.expectancyR >= 0 ? "+" : ""}${stats.expectancyR.toFixed(2)}R` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground" title="average distance from entry to stop across the decided trades">
            Avg risk
          </dt>
          <dd className="num font-mono">{stats.avgRiskPct !== null ? `${stats.avgRiskPct.toFixed(2)}%` : "—"}</dd>
        </div>
      </dl>
    </div>
  );
}
