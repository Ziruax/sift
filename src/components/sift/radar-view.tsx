"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, Filter, Radio, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCompact } from "@/lib/market/format";
import type { RadarSnapshot, RadarRow, TradePlan } from "@/lib/market/types";
import { EmptyState, LivePrice, Pct, RadarBadgeChip, RowSkeleton, Sparkline, SpikeMeter, BuyBar } from "./primitives";
import { FinalScorePill, VerdictChip, WarningsRow, FilterCheckList, ScenarioList, TradePlanCard, WallLine } from "./v2-primitives";

type Group = "all" | "go_long" | "go_short" | "watch" | "pumping" | "lead" | "dumping" | "avoid";

const GROUPS: { id: Group; label: string; test: (r: RadarRow) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "go_long", label: "GO LONG — V2", test: (r) => r.v2?.verdict === "go_long" },
  { id: "go_short", label: "GO SHORT — V2", test: (r) => r.v2?.verdict === "go_short" },
  { id: "watch", label: "Watch only", test: (r) => r.v2?.verdict === "watch" },
  { id: "pumping", label: "Pumping now", test: (r) => r.signal === "pumping" },
  { id: "lead", label: "Volume leading", test: (r) => r.volumeLead },
  { id: "dumping", label: "Dumping", test: (r) => r.badge === "dumping" || r.signal === "dumping" },
  { id: "avoid", label: "Pumped — avoid", test: (r) => r.badge === "pumped" },
];

export function RadarView({
  snapshot,
  onOpenPair,
  onLaunchBot,
}: {
  snapshot: RadarSnapshot | null;
  onOpenPair: (pair: string) => void;
  onLaunchBot?: (pair: string, plan: TradePlan) => void;
}) {
  const [group, setGroup] = useState<Group>("all");
  const [hidePumped, setHidePumped] = useState(true);
  const [hideStable, setHideStable] = useState(true);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

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
    if (hideStable) list = list.filter((r) => r.v2?.verdict !== "stable");
    const g = GROUPS.find((x) => x.id === group);
    return g ? list.filter(g.test) : list;
  }, [snapshot, group, hidePumped, hideStable]);

  const banner = useMemo(() => {
    if (!snapshot) return null;
    return (
      snapshot.rows.find((r) => r.v2?.verdict === "go_long" && r.volume24h >= 5_000_000) ??
      snapshot.rows.find((r) => r.v2?.verdict === "go_long") ??
      snapshot.rows.find(
        (r) => r.signal === "pumping" && r.score >= 80 && r.volume24h >= 5_000_000 && r.badge !== "pumped",
      ) ??
      null
    );
  }, [snapshot]);

  const counts = useMemo(() => {
    if (!snapshot) return {} as Partial<Record<Group, number>>;
    const out: Partial<Record<Group, number>> = {};
    const base = snapshot.rows.filter((r) => (hidePumped ? r.badge !== "pumped" : true) && (hideStable ? r.v2?.verdict !== "stable" : true));
    for (const g of GROUPS) {
      if (g.id === "all") continue;
      out[g.id] = base.filter(g.test).length;
    }
    return out;
  }, [snapshot, hidePumped, hideStable]);

  if (!snapshot) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-64 animate-pulse rounded-lg bg-muted" />
        <RowSkeleton rows={9} />
      </div>
    );
  }

  const expand = (pair: string) => setExpanded((prev) => (prev === pair ? null : pair));

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
        <div className="flex flex-wrap gap-3">
          <label className="flex min-h-9 cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
            <Filter className="size-3.5" aria-hidden="true" />
            <span className={cn(hideStable && "text-foreground")}>Hide stablecoins</span>
            <input
              type="checkbox"
              checked={hideStable}
              onChange={(e) => setHideStable(e.target.checked)}
              className="size-4 accent-(--up)"
            />
          </label>
          <label className="flex min-h-9 cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
            <span className={cn(hidePumped && "text-foreground")}>Hide already-pumped</span>
            <input
              type="checkbox"
              checked={hidePumped}
              onChange={(e) => setHidePumped(e.target.checked)}
              className="size-4 accent-(--up)"
            />
          </label>
        </div>
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
          onClick={() => expand(banner.pair)}
          className="flex w-full items-center gap-3 rounded-xl border border-up/40 bg-up-soft px-4 py-3 text-left transition-transform hover:scale-[1.005]"
        >
          <Zap className="size-5 shrink-0 text-up" aria-hidden="true" />
          <span className="flex-1 text-sm">
            {banner.v2?.verdict === "go_long" ? (
              <>
                <strong className="font-semibold text-up">{banner.base}</strong> passed all seven V2 filters — final score{" "}
                {banner.v2.longScore}, {banner.rvol.toFixed(1)}× volume on {formatCompact(banner.vol5mUsd)} real dollars.
                Tap for the trade plan.
              </>
            ) : (
              <>
                <strong className="font-semibold text-up">{banner.base}</strong> is pumping — score {banner.score},{" "}
                <Pct value={banner.change5m} /> in 5m on {banner.rvol.toFixed(1)}× volume. Tap to track it.
              </>
            )}
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
              <th scope="col" className="w-8 px-2 py-2.5" aria-label="Expand details" />
              <th scope="col" className="px-4 py-2.5 font-medium">Coin</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Price</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">5m</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">15m</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">24h</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium" title="Real dollars traded in the last 5 minutes — not the ×multiple">Vol $5m</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Vol spike</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Buy %</th>
              <th scope="col" className="px-3 py-2.5 text-center font-medium" title="V2 final score: base + momentum + dollar volume + wall + liquidity">V2</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Verdict</th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">1h</th>
            </tr>
          </thead>
          <tbody className="max-h-[70vh] overflow-y-auto">
            {rows.map((r) => (
              <RadarRowLine key={r.pair} row={r} expanded={expanded === r.pair} onExpand={expand} onOpenPair={onOpenPair} onLaunchBot={onLaunchBot} />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="p-4">
            <EmptyState
              title="No coins in this group right now"
              body="The scanner updates every 5 seconds. Flat markets have few signals — that is the point: the V2 filters only speak when seven checks agree."
            />
          </div>
        )}
      </div>

      {/* Cards (mobile) */}
      <div className="space-y-2 md:hidden">
        {rows.map((r) => (
          <div key={r.pair} className="rounded-xl border border-border bg-card">
            <button
              type="button"
              onClick={() => onOpenPair(r.pair)}
              className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-accent/5"
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
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span className="num font-mono">{formatCompact(r.vol5mUsd)} in 5m</span>
                  <span className="num font-mono">{r.trades5m} trades</span>
                </div>
                <div className="mt-2 flex items-center gap-4">
                  <SpikeMeter rvol={r.rvol} />
                  <BuyBar buyPct={r.buyPct} />
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {r.v2 ? <FinalScorePill score={r.v2.longScore} verdict={r.v2.verdict} size="sm" /> : <ScorePlaceholder />}
                <Sparkline points={r.spark} />
              </div>
            </button>
            {r.v2 && (
              <button
                type="button"
                onClick={() => expand(r.pair)}
                className="flex w-full items-center justify-between gap-2 border-t border-border/60 px-3 py-2 text-left"
                aria-expanded={expanded === r.pair}
              >
                <VerdictChip verdict={r.v2.verdict} size="sm" />
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  plan & scenarios
                  <ChevronDown className={cn("size-3.5 transition-transform", expanded === r.pair && "rotate-180")} aria-hidden="true" />
                </span>
              </button>
            )}
            {expanded === r.pair && r.v2 && (
              <div className="border-t border-border/60 p-3">
                <RowDetail v2={r.v2} onLaunchBot={onLaunchBot ? (plan) => onLaunchBot(r.pair, plan) : undefined} />
              </div>
            )}
          </div>
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

function ScorePlaceholder() {
  return <span className="num inline-flex h-6 min-w-9 items-center justify-center rounded-md border border-border font-mono text-xs text-muted-foreground">—</span>;
}

function RadarRowLine({
  row,
  expanded,
  onExpand,
  onOpenPair,
  onLaunchBot,
}: {
  row: RadarRow;
  expanded: boolean;
  onExpand: (pair: string) => void;
  onOpenPair: (pair: string) => void;
  onLaunchBot?: (pair: string, plan: TradePlan) => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-accent/5 focus-visible:bg-accent/10 focus-visible:outline-none"
        onClick={() => onOpenPair(row.pair)}
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onOpenPair(row.pair)}
      >
        <td className="px-2 py-2.5">
          {row.v2 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onExpand(row.pair);
              }}
              aria-label={expanded ? `Collapse ${row.base} details` : `Expand ${row.base} trade plan and scenarios`}
              aria-expanded={expanded}
              className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
            </button>
          )}
        </td>
        <td className="px-4 py-2.5">
          <span className="font-semibold">{row.base}</span>
          <span className="ml-1.5 text-[11px] text-muted-foreground">USDT</span>
          {r2Warnings(row).length > 0 && (
            <span
              className="ml-2 inline-flex items-center rounded bg-down-soft px-1 py-0.5 align-middle text-[10px] font-medium leading-none text-down"
              title={r2Warnings(row).join(" · ")}
            >
              ⚠
            </span>
          )}
          {row.volumeLead && (
            <span className="ml-2 rounded bg-accent px-1 py-0.5 text-[10px] font-medium leading-none text-accent-foreground">vol lead</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right"><LivePrice price={row.price} /></td>
        <td className="px-3 py-2.5 text-right"><Pct value={row.change5m} /></td>
        <td className="px-3 py-2.5 text-right"><Pct value={row.change15m} /></td>
        <td className="px-3 py-2.5 text-right"><Pct value={row.change24h} /></td>
        <td className="num px-3 py-2.5 text-right font-mono text-xs" title={`${Math.round(row.vol5mUsd).toLocaleString()} USD in the last 5 minutes`}>
          <span className={row.vol5mUsd < 50_000 ? "text-down" : row.vol5mUsd > 100_000 ? "text-up" : "text-muted-foreground"}>
            {formatCompact(row.vol5mUsd)}
          </span>
        </td>
        <td className="px-3 py-2.5"><SpikeMeter rvol={row.rvol} /></td>
        <td className="px-3 py-2.5">
          <span className="inline-flex items-center gap-1.5">
            <BuyBar buyPct={row.buyPct} />
            <span className="num hidden font-mono text-[10px] text-muted-foreground xl:inline" title="Trades in the last 5 minutes — validates the buy % is a crowd, not one whale">
              {row.trades5m}tr
            </span>
          </span>
        </td>
        <td className="px-3 py-2.5 text-center">
          {row.v2 ? <FinalScorePill score={row.v2.longScore} verdict={row.v2.verdict} /> : <ScorePlaceholder />}
        </td>
        <td className="px-3 py-2.5">{row.v2 ? <VerdictChip verdict={row.v2.verdict} /> : <RadarBadgeChip badge={row.badge} />}</td>
        <td className="px-4 py-2.5 text-right"><Sparkline points={row.spark} className="ml-auto block" /></td>
      </tr>
      {expanded && row.v2 && (
        <tr className="border-b border-border/60 bg-muted/20">
          <td colSpan={12} className="px-4 py-3">
            <RowDetail v2={row.v2} onLaunchBot={onLaunchBot ? (plan) => onLaunchBot(row.pair, plan) : undefined} />
          </td>
        </tr>
      )}
    </>
  );
}

function r2Warnings(row: RadarRow): string[] {
  return row.v2?.warnings ?? [];
}

/** The expanded detail: wall, warnings, plan, filters, scenarios. */
function RowDetail({ v2, onLaunchBot }: { v2: NonNullable<RadarRow["v2"]>; onLaunchBot?: (plan: TradePlan) => void }) {
  return (
    <div className="space-y-3">
      <WarningsRow warnings={v2.warnings} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <WallLine wall={v2.wall} known={v2.wallKnown} broken={v2.wallBroken} />
        {v2.atrPct !== null && (
          <span className="num text-[11px] text-muted-foreground" title="Average true range on 1-minute candles — the coin's own volatility">
            ATR1m {v2.atrPct.toFixed(2)}%
          </span>
        )}
      </div>
      {v2.trade && <TradePlanCard plan={v2.trade} onLaunchBot={onLaunchBot} />}
      {v2.shortTrade && v2.shortVerdict === "go" && <TradePlanCard plan={v2.shortTrade} onLaunchBot={onLaunchBot} />}
      <FilterCheckList checks={v2.checks} />
      <ScenarioList scenarios={v2.scenarios} />
    </div>
  );
}
