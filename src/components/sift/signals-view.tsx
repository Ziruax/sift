"use client";

import { useQuery } from "@tanstack/react-query";
import { Award, Clock, Flame, Target } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { SIGNAL_META, SIGNAL_ORDER } from "@/lib/market/format";
import type { MarketSignal, SignalType, SignalsResponse } from "@/lib/market/types";
import { EmptyState, Pct, RowSkeleton, ScorePill, SignalTypeChip } from "./primitives";

async function fetchSignals(type: string | null): Promise<SignalsResponse> {
  const url = type ? `/api/signals?type=${type}` : "/api/signals";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<SignalsResponse>;
}

function useSignals(type: string | null, refreshKey: number) {
  return useQuery<SignalsResponse>({
    queryKey: ["signals", type, refreshKey],
    queryFn: () => fetchSignals(type),
    refetchInterval: 30_000,
  });
}

function graded(change: number | null, direction: "long" | "short"): number | null {
  if (change === null || !Number.isFinite(change)) return null;
  return direction === "long" ? change : -change;
}

export function SignalsView({ refreshKey, onOpenPair }: { refreshKey: number; onOpenPair: (pair: string) => void }) {
  const [type, setType] = useState<SignalType | "all">("all");
  const { data, isLoading, isError, error } = useSignals(type === "all" ? null : type, refreshKey);

  return (
    <div className="space-y-4">
      <section aria-label="What is this" className="rounded-xl border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Award className="size-4 text-up" aria-hidden="true" />
          Every signal, graded by what actually happened next
        </h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          The scanner never sleeps: it scores the top Binance pairs every 5 seconds, fires signals when the tape
          changes character, and then waits. Five, fifteen and sixty minutes later it records what the price really
          did — direction-adjusted, so a dump signal counts as a win when the price falls. MFE / MAE are the best and
          worst excursions inside the first hour. This is how you tell a real tell from noise.
        </p>
      </section>

      {/* Per-type stats */}
      <section aria-label="Signal performance" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {SIGNAL_ORDER.map((t) => {
          const stat = data?.stats.find((s) => s.type === t);
          const meta = SIGNAL_META[t];
          return (
            <div
              key={t}
              className={cn(
                "rounded-xl border p-3",
                type === t ? "border-primary" : "border-border bg-card",
              )}
              role="button"
              tabIndex={0}
              onClick={() => setType(type === t ? "all" : t)}
              onKeyDown={(e) => e.key === "Enter" && setType(type === t ? "all" : t)}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" title={meta.label}>
                  {meta.short}
                </span>
                <span className="num font-mono text-[11px] text-muted-foreground">{stat?.count ?? 0}</span>
              </div>
              <p className="num mt-1 font-mono text-lg font-semibold leading-none">
                {stat?.winRate !== null && stat?.winRate !== undefined ? `${(stat.winRate * 100).toFixed(0)}%` : "—"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {stat?.winRate !== null && stat?.winRate !== undefined ? `${stat.wins}/${stat.finals} wins @60m` : "no finals yet"}
              </p>
              {stat?.avgChange60m !== null && stat?.avgChange60m !== undefined && (
                <p className="mt-1">
                  <Pct value={stat.avgChange60m} />
                </p>
              )}
            </div>
          );
        })}
      </section>

      {/* Type filter */}
      <div role="group" aria-label="Filter by signal type" className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setType("all")}
          aria-pressed={type === "all"}
          className={cn(
            "flex min-h-9 items-center rounded-lg border px-2.5 text-xs font-medium transition-colors",
            type === "all" ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          All types
        </button>
        {SIGNAL_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            aria-pressed={type === t}
            className={cn(
              "flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors",
              type === t ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {SIGNAL_META[t].short}
          </button>
        ))}
      </div>

      {/* Log */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-sm font-semibold">Opportunity log</h3>
          {data && <span className="num rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{data.total} total</span>}
        </div>

        {isLoading ? (
          <div className="p-4"><RowSkeleton rows={8} /></div>
        ) : isError ? (
          <div className="p-4"><EmptyState title="Signal log unavailable" body={error.message} /></div>
        ) : !data || data.signals.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No signals recorded yet"
              body="The scanner has been quiet — either the market is flat or the service just started. Signals appear here the moment the tape changes character."
            />
          </div>
        ) : (
          <div className="max-h-[65vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="py-2.5 pl-4 pr-2 font-medium">Time</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Coin</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Signal</th>
                  <th scope="col" className="px-2 py-2.5 text-center font-medium">Score</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-medium">At price</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-medium">+5m</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-medium">+15m</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-medium">+60m</th>
                  <th scope="col" className="hidden px-2 py-2.5 text-right font-medium md:table-cell">MFE</th>
                  <th scope="col" className="hidden px-2 py-2.5 text-right font-medium md:table-cell">MAE</th>
                  <th scope="col" className="hidden px-2 py-2.5 pr-4 text-right font-medium lg:table-cell">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.signals.map((s: MarketSignal) => {
                  const g5 = graded(s.change5m, s.direction);
                  const g15 = graded(s.change15m, s.direction);
                  const g60 = graded(s.change60m, s.direction);
                  const pending = s.status === "pending";
                  return (
                    <tr
                      key={s.id}
                      className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-accent/5"
                      onClick={() => onOpenPair(s.pair)}
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && onOpenPair(s.pair)}
                      title={s.note ?? SIGNAL_META[s.type].hint}
                    >
                      <td className="num py-2.5 pl-4 pr-2 font-mono text-xs text-muted-foreground">
                        {new Date(s.createdAt).toLocaleTimeString([], { hour12: false })}
                      </td>
                      <td className="px-2 py-2.5 font-semibold">{s.base}</td>
                      <td className="px-2 py-2.5"><SignalTypeChip type={s.type} compact /></td>
                      <td className="px-2 py-2.5 text-center"><ScorePill score={s.score} size="sm" /></td>
                      <td className="num px-2 py-2.5 text-right font-mono text-xs">
                        {s.price < 0.01 ? s.price.toPrecision(4) : s.price.toFixed(s.price < 100 ? 4 : 2)}
                      </td>
                      <td className="px-2 py-2.5 text-right">{pending && s.change5m === null ? <span className="text-[10px] text-muted-foreground">…</span> : <Pct value={g5 ?? s.change5m} />}</td>
                      <td className="px-2 py-2.5 text-right">{pending && s.change15m === null ? <span className="text-[10px] text-muted-foreground">…</span> : <Pct value={g15 ?? s.change15m} />}</td>
                      <td className="px-2 py-2.5 text-right">
                        {s.change60m === null ? (
                          <span className="text-[10px] text-muted-foreground">{s.status === "final" ? "—" : "…"}</span>
                        ) : (
                          <Pct value={g60 ?? s.change60m} className="font-medium" />
                        )}
                      </td>
                      <td className="hidden px-2 py-2.5 text-right md:table-cell"><Pct value={s.mfe} /></td>
                      <td className="hidden px-2 py-2.5 text-right md:table-cell"><Pct value={s.mae} /></td>
                      <td className="hidden px-2 py-2.5 pr-4 text-right lg:table-cell">
                        {s.status === "final" ? (
                          <span className={cn(
                            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                            (g60 ?? 0) > 0 ? "border-up/40 bg-up-soft text-up" : "border-down/40 bg-down-soft text-down",
                          )}>
                            <Target className="size-2.5" aria-hidden="true" />
                            {(g60 ?? 0) > 0 ? "worked" : "missed"}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Flame className="size-2.5" aria-hidden="true" />
                            live
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        “Worked” means the price moved in the signal&rsquo;s direction within the first hour — it does not mean the move was
        tradable after fees. MFE is the best excursion the signal offered; MAE the worst drawdown it endured. Use them
        together: a signal with +3% MFE and −0.4% MAE was a cleaner opportunity than one with +6% and −5%.
      </p>
    </div>
  );
}
