"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Filter, Radio, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RadarSnapshot, RadarRow } from "@/lib/market/types";
import { EmptyState, LivePrice, Pct, RadarBadgeChip, RowSkeleton, ScorePill, Sparkline, SpikeMeter, BuyBar } from "./primitives";

type Group = "all" | "pumping" | "lead" | "long" | "short" | "dumping" | "avoid";

const GROUPS: { id: Group; label: string; test: (r: RadarRow) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "pumping", label: "Pumping now", test: (r) => r.signal === "pumping" },
  { id: "lead", label: "Volume leading", test: (r) => r.volumeLead },
  { id: "long", label: "Go long", test: (r) => r.signal === "long" },
  { id: "short", label: "Go short", test: (r) => r.signal === "short" },
  { id: "dumping", label: "Dumping", test: (r) => r.badge === "dumping" || r.signal === "dumping" },
  { id: "avoid", label: "Pumped — avoid", test: (r) => r.badge === "pumped" },
];

export function RadarView({
  snapshot,
  onOpenPair,
}: {
  snapshot: RadarSnapshot | null;
  onOpenPair: (pair: string) => void;
}) {
  const [group, setGroup] = useState<Group>("all");
  const [hidePumped, setHidePumped] = useState(true);
  const [secondsAgo, setSecondsAgo] = useState(0);

  useEffect(() => {
    if (!snapshot) return;
    const tick = () => setSecondsAgo(Math.max(0, Math.round((Date.now() - new Date(snapshot.updatedAt).getTime()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [snapshot?.updatedAt]);

  const rows = useMemo(() => {
    if (!snapshot) return [];
    let list = snapshot.rows;
    if (hidePumped) list = list.filter((r) => r.badge !== "pumped");
    const g = GROUPS.find((x) => x.id === group);
    return g ? list.filter(g.test) : list;
  }, [snapshot, group, hidePumped]);

  const banner = useMemo(() => {
    if (!snapshot) return null;
    const hit = snapshot.rows.find(
      (r) => r.signal === "pumping" && r.score >= 80 && r.volume24h >= 5_000_000 && r.badge !== "pumped",
    );
    return hit ?? null;
  }, [snapshot]);

  const counts = useMemo(() => {
    if (!snapshot) return {} as Partial<Record<Group, number>>;
    const out: Partial<Record<Group, number>> = {};
    for (const g of GROUPS) {
      if (g.id === "all") continue;
      out[g.id] = snapshot.rows.filter((r) => (hidePumped ? r.badge !== "pumped" : true) && g.test(r)).length;
    }
    return out;
  }, [snapshot, hidePumped]);

  if (!snapshot) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-64 animate-pulse rounded-lg bg-muted" />
        <RowSkeleton rows={9} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Status strip */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Radio className="size-3.5 text-up" aria-hidden="true" />
          <span className="num font-mono">
            {snapshot.scans > 0 ? `scan #${snapshot.scans.toLocaleString()}` : "first scan"} · {snapshot.universe} pairs · updated{" "}
            {secondsAgo < 60 ? `${secondsAgo}s ago` : `${Math.floor(secondsAgo / 60)}m ago`}
          </span>
        </p>
        <label className="flex min-h-9 cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
          <Filter className="size-3.5" aria-hidden="true" />
          <span className={cn(hidePumped && "text-foreground")}>Hide already-pumped (+8% on the day)</span>
          <input
            type="checkbox"
            checked={hidePumped}
            onChange={(e) => setHidePumped(e.target.checked)}
            className="size-4 accent-(--up)"
          />
        </label>
      </div>

      {snapshot.stale && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-transparent px-3 py-2 text-xs text-warn">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          The Binance feed stalled — this is the last good scan. Retry is automatic.
        </div>
      )}

      {banner && (
        <button
          type="button"
          onClick={() => onOpenPair(banner.pair)}
          className="flex w-full items-center gap-3 rounded-xl border border-up/40 bg-up-soft px-4 py-3 text-left transition-transform hover:scale-[1.005]"
        >
          <Zap className="size-5 shrink-0 text-up" aria-hidden="true" />
          <span className="flex-1 text-sm">
            <strong className="font-semibold text-up">{banner.base}</strong> is pumping — score {banner.score},{" "}
            <Pct value={banner.change5m} /> in 5m on {banner.rvol.toFixed(1)}× volume. Tap to track it.
          </span>
          <Pct value={banner.change24h} className="text-sm" />
        </button>
      )}

      {/* Group chips */}
      <div role="tablist" aria-label="Signal groups" className="flex flex-wrap gap-1.5">
        {GROUPS.map((g) => {
          const count = g.id === "all" ? rows.length : (counts[g.id] ?? 0);
          const active = group === g.id;
          return (
            <button
              key={g.id}
              role="tab"
              aria-selected={active}
              onClick={() => setGroup(g.id)}
              className={cn(
                "flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors",
                active ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {g.label}
              <span className="num rounded-full bg-muted px-1.5 font-mono text-[10px] leading-4">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Table (desktop) */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-card md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="px-4 py-2.5 font-medium">Coin</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Price</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">1m</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">5m</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">15m</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">24h</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Vol spike</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Buy %</th>
              <th scope="col" className="px-3 py-2.5 text-center font-medium">Score</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Signal</th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">1h</th>
            </tr>
          </thead>
          <tbody className="max-h-[70vh] overflow-y-auto">
            {rows.map((r) => (
              <tr
                key={r.pair}
                onClick={() => onOpenPair(r.pair)}
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && onOpenPair(r.pair)}
                className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-accent/5 focus-visible:bg-accent/10 focus-visible:outline-none"
              >
                <td className="px-4 py-2.5">
                  <span className="font-semibold">{r.base}</span>
                  <span className="ml-1.5 text-[11px] text-muted-foreground">USDT</span>
                  {r.volumeLead && (
                    <span className="ml-2 rounded bg-accent px-1 py-0.5 text-[10px] font-medium leading-none text-accent-foreground">vol lead</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right"><LivePrice price={r.price} /></td>
                <td className="px-3 py-2.5 text-right"><Pct value={r.change1m} /></td>
                <td className="px-3 py-2.5 text-right"><Pct value={r.change5m} /></td>
                <td className="px-3 py-2.5 text-right"><Pct value={r.change15m} /></td>
                <td className="px-3 py-2.5 text-right"><Pct value={r.change24h} /></td>
                <td className="px-3 py-2.5"><SpikeMeter rvol={r.rvol} /></td>
                <td className="px-3 py-2.5"><BuyBar buyPct={r.buyPct} /></td>
                <td className="px-3 py-2.5 text-center"><ScorePill score={r.score} /></td>
                <td className="px-3 py-2.5"><RadarBadgeChip badge={r.badge} /></td>
                <td className="px-4 py-2.5 text-right"><Sparkline points={r.spark} className="ml-auto block" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="p-4">
            <EmptyState
              title="No coins in this group right now"
              body="The scanner updates every 5 seconds. Flat markets have few signals — that is the point: it only speaks when something moves."
            />
          </div>
        )}
      </div>

      {/* Cards (mobile) */}
      <div className="space-y-2 md:hidden">
        {rows.map((r) => (
          <button
            key={r.pair}
            type="button"
            onClick={() => onOpenPair(r.pair)}
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent/5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold">{r.base}</span>
                <span className="text-[10px] text-muted-foreground">USDT</span>
                {r.volumeLead && <span className="rounded bg-accent px-1 text-[10px] leading-4 text-accent-foreground">vol lead</span>}
              </div>
              <div className="mt-1 flex items-center gap-3 text-xs">
                <LivePrice price={r.price} />
                <Pct value={r.change5m} />
                <Pct value={r.change24h} />
              </div>
              <div className="mt-2 flex items-center gap-4">
                <SpikeMeter rvol={r.rvol} />
                <BuyBar buyPct={r.buyPct} />
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <ScorePill score={r.score} size="sm" />
              <Sparkline points={r.spark} />
            </div>
          </button>
        ))}
        {rows.length === 0 && (
          <EmptyState
            title="No coins in this group right now"
            body="The scanner updates every 5 seconds. Flat markets have few signals — that is the point."
          />
        )}
      </div>
    </div>
  );
}
