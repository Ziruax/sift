"use client";

// ── Backtest — prove the V2 filters on real history before trusting them ─────
//
// Runs entirely in the browser: fetches 5-minute candles straight from
// Binance's public API for the top-volume pairs plus BTC, replays them through
// the exact same seven-filter engine the live radar uses (via
// backtestSymbol), and grades every go-signal against its own stop and
// take-profits. One honest limitation, stated up front: historical order books
// are not freely available, so the wall filter is off in the replay — the live
// engine adds it, which can only reject more setups, never invent wins.

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FlaskConical, Play, RotateCcw, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPrice } from "@/lib/market/format";
import { backtestSymbol, statsFor, type BacktestBar, type BacktestStats, type BacktestTrade } from "@/lib/market/v2-engine";

const REST_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
const STABLE_BASES = new Set(["USDT", "USDC", "FDUSD", "DAI", "TUSD", "USDP", "BUSD", "BFUSD", "USDS"]);
const FIAT_BASES = new Set(["EUR", "GBP", "BRL", "AUD", "TRY", "NGN", "UAH", "ARS", "MXN", "ZAR", "PLN", "CZK", "HUF", "ILS"]);
const PEGGED_BASES = new Set(["RLUSD", "USD1", "USDE", "USD0", "PYUSD", "EURC", "USDD", "FRAX", "LUSD", "GUSD", "XUSD", "RWUSD", "XAUT", "PAXG"]);

type Phase = "idle" | "running" | "done" | "error";

type CoinResult = {
  pair: string;
  base: string;
  bars: number;
  longs: BacktestStats;
  shorts: BacktestStats;
};

type Result = {
  ranAt: string;
  days: number;
  coins: number;
  perCoin: CoinResult[];
  longs: BacktestStats;
  shorts: BacktestStats;
  recent: BacktestTrade[];
};

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

/** Top USDT pairs by 24h quote volume, junk filtered like the live scanner. */
async function topPairs(limit: number): Promise<string[]> {
  const payload = await restFetch("/api/v3/ticker/24hr", 20_000);
  if (!Array.isArray(payload)) throw new Error("Unexpected ticker payload");
  const rows = (payload as Array<{ symbol?: unknown; quoteVolume?: unknown }>)
    .filter((row) => {
      const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : "";
      if (!symbol.endsWith("USDT")) return false;
      const base = symbol.slice(0, -4);
      if (!base || STABLE_BASES.has(base) || FIAT_BASES.has(base) || PEGGED_BASES.has(base)) return false;
      if (/^(.{2,4})(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
      return num(row.quoteVolume) > 0;
    })
    .sort((a, b) => num(b.quoteVolume) - num(a.quoteVolume))
    .slice(0, limit);
  return rows.map((r) => String(r.symbol).toUpperCase());
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

const DAYS_OPTIONS = [7, 14, 30] as const;
const COINS_OPTIONS = [10, 20, 30] as const;

export function BacktestView() {
  const [days, setDays] = useState<(typeof DAYS_OPTIONS)[number]>(14);
  const [coins, setCoins] = useState<(typeof COINS_OPTIONS)[number]>(20);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ label: "", pct: 0 });
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase("running");
    setError(null);
    setResult(null);
    try {
      const totalBars = days * 288;
      const steps = coins + 1;
      let done = 0;
      const tick = (label: string) => {
        done += 1;
        setProgress({ label, pct: Math.min(100, Math.round((done / steps) * 100)) });
      };

      setProgress({ label: "Ranking the market by volume…", pct: 2 });
      const pairs = await topPairs(coins);
      if (pairs.length === 0) throw new Error("No tradable pairs came back from Binance.");

      // BTC first — its regime gates every other symbol's longs/shorts.
      const btcBars = await fetchBars("BTCUSDT", totalBars);
      tick("BTC candles loaded");

      const perCoin: CoinResult[] = [];
      const recent: BacktestTrade[] = [];
      for (const pair of pairs) {
        setProgress({ label: `Replaying ${pair.replace(/USDT$/, "")}…`, pct: Math.min(100, Math.round((done / steps) * 100)) });
        const bars = await fetchBars(pair, totalBars);
        if (bars.length >= 60) {
          const { longs, shorts } = backtestSymbol(pair, bars, btcBars);
          perCoin.push({
            pair,
            base: pair.replace(/USDT$/, ""),
            bars: bars.length,
            longs: statsFor(longs),
            shorts: statsFor(shorts),
          });
          recent.push(...longs, ...shorts);
        }
        tick(pair);
      }

      recent.sort((a, b) => b.time - a.time);
      setResult({
        ranAt: new Date().toISOString(),
        days,
        coins: perCoin.length,
        perCoin,
        longs: aggregate(perCoin.map((c) => c.longs)),
        shorts: aggregate(perCoin.map((c) => c.shorts)),
        recent: recent.slice(0, 40),
      });
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The backtest failed to run.");
      setPhase("error");
    } finally {
      running.current = false;
    }
  }, [days, coins]);

  const verdict = (wr: number | null): { label: string; tone: "up" | "warn" | "down"; icon: typeof CheckCircle2 } => {
    if (wr === null) return { label: "No decided trades", tone: "warn", icon: AlertTriangle };
    // Honest math: at 2:1 reward-to-risk, ~34% wins breaks even. The spec's
    // 55%/65% bars sit on top of that, not instead of it.
    if (wr >= 0.65) return { label: "Exceptional — 65%+ win rate", tone: "up", icon: CheckCircle2 };
    if (wr >= 0.55) return { label: "Ship it — well above break-even", tone: "up", icon: CheckCircle2 };
    if (wr >= 0.4) return { label: "Profitable at 2:1 R:R — mind the fees", tone: "up", icon: CheckCircle2 };
    if (wr >= 0.34) return { label: "Marginal — near break-even", tone: "warn", icon: AlertTriangle };
    return { label: "Below break-even (34% at 2:1) — tune it", tone: "down", icon: AlertTriangle };
  };

  return (
    <div className="space-y-4">
      <section aria-label="What is this" className="rounded-xl border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <FlaskConical className="size-4 text-up" aria-hidden="true" />
          Backtest — the proof before the promise
        </h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Replays the exact same seven-filter V2 engine the live radar uses over days of real 5-minute Binance candles,
          in your browser. Every <strong>go long</strong> / <strong>go short</strong> it would have fired is graded
          against its own ATR-sized stop and take-profits: a win means TP1 (+2× risk) printed before the stop (−1×
          risk) within two hours. Same-bar collisions count as losses — conservative on purpose. The thresholds were
          tuned by grid search over this same history; re-run any window to keep them honest.
        </p>
        <p className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-warn/30 bg-transparent px-2.5 py-1.5 text-[11px] text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          One honest limitation: historical order books are not free, so the wall filter is off in the replay. The live
          engine adds it — it can only reject more setups, never invent wins. Fees and slippage are also not modelled.
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
        </label>
        <label className="text-xs">
          <span className="block text-muted-foreground">Coins (top by volume)</span>
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
            30-coin run takes about a minute.
          </p>
        </section>
      )}

      {phase === "error" && (
        <section className="rounded-xl border border-down/40 bg-down-soft px-4 py-3 text-sm text-down">{error}</section>
      )}

      {/* Results */}
      {phase === "done" && result && (
        <>
          <section className="grid gap-3 sm:grid-cols-2" aria-label="Backtest summary">
            <StatBlock title="Go long" side="long" stats={result.longs} verdict={verdict(result.longs.winRate)} />
            <StatBlock title="Go short" side="short" stats={result.shorts} verdict={verdict(result.shorts.winRate)} />
          </section>

          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
              <h3 className="text-sm font-semibold">Per-coin results</h3>
              <span className="num rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {result.coins} coins · {result.days} days · ran {new Date(result.ranAt).toLocaleTimeString([], { hour12: false })}
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
                    <th scope="col" className="px-2 py-2.5 text-right font-medium">Exp. long</th>
                    <th scope="col" className="hidden px-2 py-2.5 pr-4 text-right font-medium md:table-cell">Bars</th>
                  </tr>
                </thead>
                <tbody>
                  {result.perCoin.map((c) => (
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
                        <span className={c.longs.expectancyPct !== null && c.longs.expectancyPct > 0 ? "text-up" : "text-down"}>
                          {c.longs.expectancyPct !== null ? `${c.longs.expectancyPct >= 0 ? "+" : ""}${c.longs.expectancyPct.toFixed(2)}%` : "—"}
                        </span>
                      </td>
                      <td className="num hidden px-2 py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground md:table-cell">{c.bars}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

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
                    <th scope="col" className="px-2 py-2.5 text-right font-medium">P&L</th>
                    <th scope="col" className="hidden px-2 py-2.5 pr-4 text-right font-medium md:table-cell">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {result.recent.map((t, i) => (
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
                          className={cn(
                            "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                            t.outcome === "win" && "border-up/40 bg-up-soft text-up",
                            t.outcome === "big_win" && "border-up/50 bg-up-soft text-up font-bold",
                            t.outcome === "loss" && "border-down/40 bg-down-soft text-down",
                            t.outcome === "timeout" && "border-border bg-muted text-muted-foreground",
                          )}
                        >
                          {t.outcome === "big_win" ? "TP2" : t.outcome === "win" ? "TP1" : t.outcome === "loss" ? "stopped" : "timeout"}
                        </span>
                      </td>
                      <td className="num px-2 py-2.5 text-right font-mono text-xs">
                        <span className={t.pnlPct > 0 ? "text-up" : t.pnlPct < 0 ? "text-down" : "text-muted-foreground"}>
                          {t.pnlPct >= 0 ? "+" : ""}
                          {t.pnlPct.toFixed(2)}%
                        </span>
                      </td>
                      <td className="num hidden px-2 py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground md:table-cell">{t.score}</td>
                    </tr>
                  ))}
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
            keys, no server, nothing leaves your browser. The point is simple: if the win rate is under 55% the
            thresholds need tuning; if it clears 65%, the filters earn their keep.
          </p>
        </section>
      )}
    </div>
  );
}

function aggregate(stats: BacktestStats[]): BacktestStats {
  const out = {
    trades: 0, wins: 0, bigWins: 0, losses: 0, timeouts: 0,
    winRate: null as number | null, avgWinPct: null as number | null, avgLossPct: null as number | null,
    profitFactor: null as number | null, expectancyPct: null as number | null,
  };
  // Per-coin stats carry counts + averages; the aggregates below rebuild the
  // exact same numbers weighted by trade counts.
  let winSum = 0, lossSum = 0, winCount = 0, lossCount = 0, grossWin = 0, grossLoss = 0;
  let expectancyWeighted = 0, expectancyBase = 0;
  for (const s of stats) {
    out.trades += s.trades;
    out.wins += s.wins;
    out.bigWins += s.bigWins;
    out.losses += s.losses;
    out.timeouts += s.timeouts;
    if (s.avgWinPct !== null) {
      winSum += s.avgWinPct * (s.wins + s.bigWins);
      winCount += s.wins + s.bigWins;
      grossWin += s.avgWinPct * (s.wins + s.bigWins);
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
  }
  const decided = out.wins + out.bigWins + out.losses;
  out.winRate = decided > 0 ? (out.wins + out.bigWins) / decided : null;
  out.avgWinPct = winCount > 0 ? winSum / winCount : null;
  out.avgLossPct = lossCount > 0 ? lossSum / lossCount : null;
  out.profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null;
  out.expectancyPct = expectancyBase > 0 ? expectancyWeighted / expectancyBase : null;
  return out;
}

function WrCell({ wr }: { wr: number | null }) {
  if (wr === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={wr >= 0.65 ? "font-bold text-up" : wr >= 0.55 ? "text-up" : wr >= 0.5 ? "text-warn" : "text-down"}>
      {(wr * 100).toFixed(0)}%
    </span>
  );
}

function StatBlock({
  title,
  side,
  stats,
  verdict,
}: {
  title: string;
  side: "long" | "short";
  stats: BacktestStats;
  verdict: { label: string; tone: "up" | "warn" | "down"; icon: typeof CheckCircle2 };
}) {
  const Icon = verdict.icon;
  return (
    <div className={cn("rounded-xl border p-4", side === "long" ? "border-up/30 bg-up-soft/30" : "border-down/30 bg-down-soft/30")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={cn("text-sm font-semibold", side === "long" ? "text-up" : "text-down")}>{title}</h3>
        <span className={cn("flex items-center gap-1 text-[11px] font-medium", verdict.tone === "up" ? "text-up" : verdict.tone === "warn" ? "text-warn" : "text-down")}>
          <Icon className="size-3.5" aria-hidden="true" />
          {verdict.label}
        </span>
      </div>
      <p className="num mt-2 font-mono text-3xl font-bold leading-none">
        {stats.winRate !== null ? `${(stats.winRate * 100).toFixed(0)}%` : "—"}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          win rate · {stats.wins + stats.bigWins}W / {stats.losses}L / {stats.timeouts}T of {stats.trades}
        </span>
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
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
      </dl>
    </div>
  );
}
