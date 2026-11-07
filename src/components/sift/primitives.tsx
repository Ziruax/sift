"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatPct, formatPrice, SIGNAL_META } from "@/lib/market/format";
import type { RadarBadge, SignalType } from "@/lib/market/types";

// ── Live dot ────────────────────────────────────────────────────────────────

export function LiveDot({ tone = "up", pulse = true }: { tone?: "up" | "warn" | "down"; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tone === "up" && "bg-up text-up",
        tone === "warn" && "bg-warn text-warn",
        tone === "down" && "bg-down text-down",
        pulse && "pulse-dot",
      )}
    />
  );
}

// ── Percent change with sign + color ────────────────────────────────────────

export function Pct({
  value,
  className,
  digits = 2,
  neutral = false,
}: {
  value: number | null | undefined;
  className?: string;
  digits?: number;
  neutral?: boolean;
}) {
  const v = typeof value === "number" && Number.isFinite(value) ? value : null;
  return (
    <span className={cn("num", className)}>
      {v === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className={cn(!neutral && (v > 0.0001 ? "text-up" : v < -0.0001 ? "text-down" : "text-muted-foreground"))}>
          {formatPct(v, digits)}
        </span>
      )}
    </span>
  );
}

// ── Price cell that flashes on change ───────────────────────────────────────

export function LivePrice({ price, className }: { price: number; className?: string }) {
  const [state, setState] = useState<{ prev: number; flash: "" | "flash-up" | "flash-down" }>({
    prev: price,
    flash: "",
  });

  // Derived state adjusted during render (the React-endorsed pattern): when
  // the price changes we update both the previous price and the flash class.
  if (price !== state.prev) {
    setState({ prev: price, flash: price > state.prev ? "flash-up" : "flash-down" });
  }

  useEffect(() => {
    if (!state.flash) return;
    const t = setTimeout(() => setState((s) => (s.flash ? { ...s, flash: "" } : s)), 820);
    return () => clearTimeout(t);
  }, [state.flash, state.prev]);

  return <span className={cn("num inline-block rounded px-1 -mx-1 tabular-nums", state.flash, className)}>{formatPrice(price)}</span>;
}

// ── Score gauge ─────────────────────────────────────────────────────────────

export function ScorePill({ score, size = "md" }: { score: number; size?: "sm" | "md" }) {
  const tone =
    score >= 80 ? "bg-up-soft text-up border-up/40 score-hot" : score >= 60 ? "text-warn border-warn/30 bg-transparent" : "text-muted-foreground border-border bg-transparent";
  return (
    <span
      className={cn(
        "num inline-flex items-center justify-center rounded-md border font-mono font-semibold",
        size === "md" ? "min-w-11 px-1.5 h-7 text-sm" : "min-w-9 px-1 h-6 text-xs",
        tone,
      )}
      title={`Opportunity score ${score}/100`}
    >
      {score}
    </span>
  );
}

// ── Buy/sell pressure bar ───────────────────────────────────────────────────

export function BuyBar({ buyPct, className }: { buyPct: number; className?: string }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(buyPct) ? buyPct : 50));
  return (
    <div className={cn("flex items-center gap-2", className)} title={`Taker buys ${clamped.toFixed(1)}% of volume`}>
      <div className="relative h-1.5 w-14 overflow-hidden rounded-full bg-down-soft" role="img" aria-label={`Buy pressure ${clamped.toFixed(0)} percent`}>
        <div className="absolute inset-y-0 left-0 rounded-full bg-up transition-[width] duration-500" style={{ width: `${clamped}%` }} />
      </div>
      <span className={cn("num font-mono text-[11px]", clamped >= 70 ? "text-up" : clamped <= 30 ? "text-down" : "text-muted-foreground")}>
        {clamped.toFixed(0)}%
      </span>
    </div>
  );
}

// ── RVOL spike meter ────────────────────────────────────────────────────────

export function SpikeMeter({ rvol }: { rvol: number }) {
  const v = Number.isFinite(rvol) ? rvol : 0;
  const width = Math.max(4, Math.min(100, ((v - 1) / 4) * 100));
  const tone = v >= 3 ? "bg-up" : v >= 2 ? "bg-warn" : "bg-muted-foreground/40";
  return (
    <span className="inline-flex items-center gap-2" title={`5-minute volume is ${v.toFixed(2)}× the 1-hour average`}>
      <span className="relative inline-block h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500", tone)} style={{ width: `${width}%` }} />
      </span>
      <span className={cn("num font-mono text-xs", v >= 3 ? "text-up" : v >= 2 ? "text-warn" : "text-muted-foreground")}>{v.toFixed(1)}×</span>
    </span>
  );
}

// ── Sparkline (60 one-minute closes) ────────────────────────────────────────

export function Sparkline({ points, className }: { points: number[]; className?: string }) {
  if (!points || points.length < 2) return <span className={cn("block h-6 w-20", className)} aria-hidden="true" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const w = 80;
  const h = 24;
  const step = w / (points.length - 1);
  const coords = points.map((p, i) => `${(i * step).toFixed(1)},${(h - 2 - ((p - min) / span) * (h - 4)).toFixed(1)}`);
  const up = points[points.length - 1] >= points[0];
  const stroke = up ? "var(--up)" : "var(--down)";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cn("overflow-visible", className)} aria-hidden="true">
      <polyline points={coords.join(" ")} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={w} cy={coords[coords.length - 1]?.split(",")[1] ?? h / 2} r="2" fill={stroke} />
    </svg>
  );
}

// ── Badges ──────────────────────────────────────────────────────────────────

const BADGE_STYLE: Record<RadarBadge, { label: string; className: string }> = {
  pump: { label: "Pump", className: "bg-up-soft text-up border-up/40" },
  early: { label: "Early", className: "bg-accent text-accent-foreground border-accent-foreground/20" },
  dumping: { label: "Dumping", className: "bg-down-soft text-down border-down/40" },
  pumped: { label: "Pumped — avoid", className: "bg-down-soft text-down/70 border-down/20 line-through decoration-down/40" },
};

export function RadarBadgeChip({ badge }: { badge: RadarBadge | null }) {
  if (!badge) return <span className="text-muted-foreground text-xs">—</span>;
  const meta = BADGE_STYLE[badge];
  return (
    <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none", meta.className)}>
      {meta.label}
    </span>
  );
}

export function SignalTypeChip({ type, compact = false }: { type: SignalType; compact?: boolean }) {
  const meta = SIGNAL_META[type];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap",
        meta.tone === "up" && "bg-up-soft text-up border-up/40",
        meta.tone === "down" && "bg-down-soft text-down border-down/40",
        meta.tone === "warn" && "text-warn border-warn/30 bg-transparent",
        meta.tone === "info" && "bg-accent text-accent-foreground border-accent-foreground/20",
      )}
      title={meta.hint}
    >
      {compact ? meta.short : meta.label}
    </span>
  );
}

// ── Stat card ───────────────────────────────────────────────────────────────

export function Stat({
  label,
  value,
  change,
  hint,
}: {
  label: string;
  value: string;
  change?: number | null;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3" title={hint}>
      <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="num mt-1 font-mono text-xl font-semibold leading-none">{value}</p>
      {typeof change === "number" && Number.isFinite(change) && (
        <p className="mt-1.5">
          <Pct value={change} />
        </p>
      )}
    </div>
  );
}

// ── Empty / loading states ──────────────────────────────────────────────────

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

export function RowSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading market data">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}
