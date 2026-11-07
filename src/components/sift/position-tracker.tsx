"use client";

import { AlertTriangle, ArrowDown, ArrowUp, DollarSign, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCompact, formatPrice } from "@/lib/market/format";
import type { PairUpdate } from "@/lib/market/types";
import type { TrackedPosition } from "@/lib/watchlist";
import { BuyBar, EmptyState, LivePrice, Pct, ScorePill, SpikeMeter } from "./primitives";

function NumberField({
  label,
  value,
  onChange,
  step = "any",
  prefix,
  min,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: string;
  prefix?: string;
  min?: number;
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="mt-1 flex h-9 items-center rounded-lg border border-border bg-background px-2 focus-within:outline-2 focus-within:outline-ring">
        {prefix && <span className="mr-1 text-xs text-muted-foreground">{prefix}</span>}
        <input
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="num h-full w-full bg-transparent font-mono text-sm outline-none"
        />
        {suffix && <span className="ml-1 text-xs text-muted-foreground">{suffix}</span>}
      </span>
    </label>
  );
}

export function PositionTracker({
  pair,
  base,
  update,
  position,
  onSave,
}: {
  pair: string | null;
  base: string;
  update: PairUpdate | null;
  position: TrackedPosition | null;
  onSave: (p: TrackedPosition) => void;
}) {
  if (!pair) {
    return (
      <EmptyState
        title="No live pair for this coin"
        body="The radar reads Binance spot markets; this coin has no USDT pair there, so there is nothing to track live. The chart and stats below still work."
      />
    );
  }

  if (!position || !update) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Track a position</h3>
          <span className="text-[11px] text-muted-foreground">waiting for live data…</span>
        </div>
        <div className="mt-3 h-32 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  const { price } = update;

  // Default TP/SL rules from the original Sift: long +8% / −4%, short mirrored.
  const fillFromLive = () => {
    if (price <= 0) return;
    const isLong = position.direction === "long";
    onSave({
      ...position,
      entry: price,
      takeProfit: Number((price * (isLong ? 1.08 : 0.92)).toPrecision(6)),
      stopLoss: Number((price * (isLong ? 0.96 : 1.04)).toPrecision(6)),
    });
  };

  const units = position.entry > 0 ? position.investment / position.entry : 0;
  const pnl =
    position.direction === "long"
      ? (price - position.entry) * units
      : (position.entry - price) * units;
  const pnlPct = position.entry > 0 ? (pnl / position.investment) * 100 : 0;

  const hitTp = position.takeProfit > 0 && (position.direction === "long" ? price >= position.takeProfit : price <= position.takeProfit);
  const hitSl = position.stopLoss > 0 && (position.direction === "long" ? price <= position.stopLoss : price >= position.stopLoss);
  const nearTp =
    !hitTp &&
    position.takeProfit > 0 &&
    Math.abs(price - position.takeProfit) / position.takeProfit <= 0.01;
  const nearSl =
    !hitSl &&
    position.stopLoss > 0 &&
    Math.abs(price - position.stopLoss) / position.stopLoss <= 0.01;

  // Exit detectors: volume-spike collapse, buy-pressure flip, fresh dump.
  const pressureFlip =
    (position.direction === "long" && update.buyPct > 0 && update.buyPct < 40) ||
    (position.direction === "short" && update.buyPct > 0 && update.buyPct > 60);
  const freshDump = update.belowHighPct >= 3 && update.change5m < -1;
  const exitNow = hitTp || hitSl || update.spikeFalling || pressureFlip || freshDump;
  const exitReason = hitTp
    ? "Take-profit hit."
    : hitSl
      ? "Stop-loss hit."
      : update.spikeFalling
        ? "The volume spike collapsed — the crowd that pushed this move is leaving."
        : pressureFlip
          ? position.direction === "long"
            ? "Buy pressure fell under 40% — the bid flipped against your long."
            : "Buy pressure rose over 60% — the bid flipped against your short."
          : freshDump
            ? "Fresh dump detected — 3%+ below the session high and falling."
            : "";

  // Distance bars to TP and SL (0..100% of the way from entry).
  const distTo = (target: number) => {
    if (position.entry <= 0 || target <= 0 || price <= 0) return 0;
    const total = Math.abs(target - position.entry);
    if (total === 0) return 100;
    return Math.max(0, Math.min(100, (Math.abs(price - position.entry) / total) * 100));
  };

  const tpProgress = distTo(position.takeProfit);
  const slProgress = distTo(position.stopLoss);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <TrendingUp className="size-4 text-up" aria-hidden="true" />
          Track a position — {base}/USDT
        </h3>
        <button
          type="button"
          onClick={fillFromLive}
          disabled={price <= 0}
          className="flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <DollarSign className="size-3.5" aria-hidden="true" />
          I entered now
        </button>
      </div>

      {/* Fields */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <NumberField label="Investment" prefix="$" min={0} value={position.investment} onChange={(v) => onSave({ ...position, investment: v })} />
        <NumberField label="Entry price" value={position.entry} onChange={(v) => onSave({ ...position, entry: v })} />
        <div className="col-span-2 sm:col-span-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Direction</span>
          <div className="mt-1 grid grid-cols-2 rounded-lg border border-border bg-background p-0.5">
            {(["long", "short"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onSave({ ...position, direction: d })}
                aria-pressed={position.direction === d}
                className={cn(
                  "flex min-h-8 items-center justify-center gap-1 rounded-md text-xs font-medium capitalize transition-colors",
                  position.direction === d
                    ? d === "long"
                      ? "bg-up-soft text-up"
                      : "bg-down-soft text-down"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {d === "long" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
                {d}
              </button>
            ))}
          </div>
        </div>
        <NumberField label="Take-profit" value={position.takeProfit} onChange={(v) => onSave({ ...position, takeProfit: v })} />
        <NumberField label="Stop-loss" value={position.stopLoss} onChange={(v) => onSave({ ...position, stopLoss: v })} />
      </div>

      {/* Live P&L */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-background px-3 py-2.5">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Live price</p>
          <p className="font-mono text-lg font-semibold"><LivePrice price={price} /></p>
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">P&L</p>
          <p className="num font-mono text-2xl font-bold leading-none">
            <span className={pnl > 0 ? "text-up" : pnl < 0 ? "text-down" : "text-muted-foreground"}>
              {pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)} <span className="text-sm">({pnlPct >= 0 ? "+" : "−"}{Math.abs(pnlPct).toFixed(1)}%)</span>
            </span>
          </p>
        </div>
      </div>

      {/* Warnings */}
      {exitNow && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-down/50 bg-down-soft px-3 py-2.5 text-sm font-semibold text-down">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>EXIT NOW — {exitReason}</span>
        </div>
      )}
      {!exitNow && (nearTp || nearSl) && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-warn/40 px-3 py-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            About to hit {nearTp ? "take-profit" : "stop-loss"} — price is within 1% of it. This fires before the hit,
            not after.
          </span>
        </div>
      )}

      {/* TP/SL progress */}
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
            <span>Entry → TP</span>
            <span className="num font-mono">{position.takeProfit > 0 ? formatPrice(position.takeProfit) : "—"}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Distance to take profit" aria-valuenow={Math.round(tpProgress)}>
            <div className={cn("h-full rounded-full transition-[width] duration-500", hitTp ? "bg-up" : "bg-up/60")} style={{ width: `${tpProgress}%` }} />
          </div>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
            <span>Entry → SL</span>
            <span className="num font-mono">{position.stopLoss > 0 ? formatPrice(position.stopLoss) : "—"}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Distance to stop loss" aria-valuenow={Math.round(slProgress)}>
            <div className={cn("h-full rounded-full transition-[width] duration-500", hitSl ? "bg-down" : "bg-down/60")} style={{ width: `${slProgress}%` }} />
          </div>
        </div>
      </div>

      {/* Live tape panel */}
      <div className="rounded-lg border border-border bg-background p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Live tape</span>
          <ScorePill score={update.score} size="sm" />
        </div>
        <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">5m volume</span>
            <span className="num font-mono">{formatCompact(update.vol5mUsd)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">vs 1h avg</span>
            <SpikeMeter rvol={update.rvol} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Trades (5m)</span>
            <span className="num font-mono">{update.trades5m.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Buy pressure</span>
            <BuyBar buyPct={update.buyPct} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">1m / 5m / 15m</span>
            <span className="num font-mono flex gap-2">
              <Pct value={update.change1m} />
              <Pct value={update.change5m} />
              <Pct value={update.change15m} />
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">From session high</span>
            <span className="num font-mono">−{update.belowHighPct.toFixed(2)}%</span>
          </div>
        </div>
        <div className="mt-2 space-y-1 border-t border-border pt-2 text-[11px] leading-relaxed">
          {update.volumeLead && (
            <p className="text-up">Volume leading — the money arrived while the price is still flat. Earliest tell there is.</p>
          )}
          {update.spikeFalling && (
            <p className="text-warn">Volume dropping — the spike collapsed from 3×+ to under 1.5×. The crowd is leaving.</p>
          )}
          {update.askWall && (
            <p className="text-muted-foreground">
              Sell wall: <span className="num font-mono text-foreground">{formatCompact(update.askWall.valueUsd)}</span> of asks at{" "}
              <span className="num font-mono text-foreground">{formatPrice(update.askWall.price)}</span> (within 2% above price).
            </p>
          )}
          {!update.volumeLead && !update.spikeFalling && !update.askWall && (
            <p className="text-muted-foreground">No wall or anomaly in the book right now.</p>
          )}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Updates arrive every ~5 seconds from the scanner — not tick data, and it cannot alert you while this tab is
        closed. Signals are observations, not advice: a coin can reverse 30% one minute after looking strong.
      </p>
    </div>
  );
}
