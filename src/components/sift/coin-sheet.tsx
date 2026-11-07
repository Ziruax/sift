"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Star } from "lucide-react";
import { useCallback } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { formatCompact, formatDay, formatSupply, formatPrice, pairForSymbol } from "@/lib/market/format";
import { getCoin, lookupByPair } from "@/lib/market/client";
import type { CoinDetail, MarketSignal, SignalsResponse } from "@/lib/market/types";
import { usePosition } from "@/lib/watchlist";
import { queueBotPrefill } from "@/lib/bots";
import { useLocalSignals, usePairStream } from "@/hooks/use-radar-socket";
import { PriceChart } from "./price-chart";
import { PositionTracker, type BotLaunchPrefill } from "./position-tracker";
import { Pct, SignalTypeChip } from "./primitives";
import { V2Panel } from "./v2-primitives";
import type { TradePlan } from "@/lib/market/types";

export type CoinTarget = { kind: "id"; id: string } | { kind: "pair"; pair: string } | null;

function useCoinDetail(target: CoinTarget) {
  const idKey = target?.kind === "id" ? target.id : null;
  const pairKey = target?.kind === "pair" ? target.pair : null;

  const byId = useQuery<CoinDetail>({
    queryKey: ["coin", idKey],
    queryFn: () => getCoin(idKey as string),
    enabled: idKey !== null,
    staleTime: 60_000,
    retry: 1,
  });

  const byPair = useQuery<CoinDetail | null>({
    queryKey: ["lookup", pairKey],
    queryFn: () => lookupByPair(pairKey as string),
    enabled: pairKey !== null && !byId.data,
    staleTime: 300_000,
    retry: 1,
  });

  if (idKey !== null) return byId;
  return {
    ...byPair,
    data: byPair.data ?? undefined,
    isLoading: byPair.isLoading,
  } as typeof byId;
}

const CHANGES: { key: keyof CoinDetail["coin"]; label: string }[] = [
  { key: "change15m", label: "15m" },
  { key: "change30m", label: "30m" },
  { key: "change1h", label: "1h" },
  { key: "change6h", label: "6h" },
  { key: "change24h", label: "24h" },
  { key: "change7d", label: "7d" },
];

export function CoinSheet({
  target,
  onClose,
  subscribe,
  unsubscribe,
  isStarred,
  onToggleStar,
  onNavigate,
}: {
  target: CoinTarget;
  onClose: () => void;
  subscribe: (pair: string) => void;
  unsubscribe: (pair: string) => void;
  isStarred: (id: string) => boolean;
  onToggleStar: (id: string) => void;
  onNavigate: (tab: "bots") => void;
}) {
  const detail = useCoinDetail(target);
  const coin = detail.data?.coin ?? null;
  const pair = coin ? pairForSymbol(coin.symbol) : target?.kind === "pair" ? target.pair : null;
  const base = pair ? pair.replace(/USDT$/, "") : "";
  const update = usePairStream(pair, subscribe, unsubscribe);
  const { position, save } = usePosition(pair);
  const localSignals = useLocalSignals();

  const signals = useQuery<MarketSignal[]>({
    queryKey: ["pair-signals", pair],
    queryFn: async () => {
      // Server log first (works where the backend lives); the browser
      // engine's log fills in whenever the server is unreachable.
      try {
        const res = await fetch(`/api/signals?pair=${encodeURIComponent(pair ?? "")}&limit=8`, { cache: "no-store" });
        if (!res.ok) return [];
        const body = (await res.json()) as SignalsResponse;
        return body.signals;
      } catch {
        return [];
      }
    },
    enabled: pair !== null,
    refetchInterval: 30_000,
  });

  // Merge server + local-engine signals for this pair, newest first.
  const mergedSignals = pair
    ? [...localSignals.filter((s) => s.pair === pair), ...(signals.data ?? []).filter((s) => !localSignals.some((l) => l.id === s.id))]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 8)
    : [];

  const open = target !== null;

  // Hand the position to the Bots tab: queue the prefill (the form may not
  // be mounted yet), dispatch the event for the already-mounted case, then
  // navigate there.
  const launchBot = useCallback(
    (prefill: BotLaunchPrefill) => {
      queueBotPrefill(prefill);
      window.dispatchEvent(new CustomEvent("sift:prefill-bot", { detail: prefill }));
      onNavigate("bots");
    },
    [onNavigate],
  );

  // V2 trade plan → bot ranges (target zone = TP1..TP2, stop brackets the SL).
  const launchBotFromPlan = useCallback(
    (plan: TradePlan) => {
      launchBot({
        pair: pair ?? "",
        base: base || (coin?.symbol ?? ""),
        investment: 100,
        entry: plan.entry,
        direction: plan.side,
        targetLow: Math.min(plan.tp1, plan.tp2),
        targetHigh: Math.max(plan.tp1, plan.tp2),
        stopLow: Math.min(plan.stop * 0.9985, plan.stop),
        stopHigh: Math.max(plan.stop * 1.0015, plan.stop),
        note: `V2 ${plan.side} plan — stop ±${plan.riskPct.toFixed(2)}% sized to ${plan.atrPct !== null ? `${plan.atrPct.toFixed(2)}% ATR` : "default risk"}`,
      });
    },
    [launchBot, pair, base, coin?.symbol],
  );

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl md:max-w-2xl bg-background"
      >
        <SheetHeader className="space-y-0 border-b border-border px-5 py-4">
          <SheetDescription className="sr-only">
            Live market detail, price history and position tracker for {coin?.name ?? base}
          </SheetDescription>
          <SheetTitle asChild>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {detail.isLoading ? (
                  <div className="h-7 w-40 animate-pulse rounded bg-muted" />
                ) : coin ? (
                  <>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="truncate text-xl font-semibold">{coin.name}</span>
                      <span className="font-mono text-sm text-muted-foreground">{coin.symbol}</span>
                      {coin.rank > 0 && (
                        <span className="num rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          #{coin.rank}
                        </span>
                      )}
                    </div>
                    <p className="num mt-1.5 font-mono text-2xl font-bold leading-none">
                      {formatPrice(coin.price)}
                      <span className="ml-3 text-sm font-medium">
                        <Pct value={coin.change24h} />
                      </span>
                    </p>
                  </>
                ) : (
                  <span className="font-mono text-xl font-semibold">{base || "Coin"}</span>
                )}
              </div>
              {coin && (
                <button
                  type="button"
                  onClick={() => onToggleStar(coin.id)}
                  className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:text-warn focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={isStarred(coin.id) ? "Remove from watchlist" : "Add to watchlist"}
                  aria-pressed={isStarred(coin.id)}
                >
                  <Star className={cn("size-4", isStarred(coin.id) && "fill-warn text-warn")} />
                </button>
              )}
            </div>
          </SheetTitle>

          {coin && (
            <div className="mt-3 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
              {CHANGES.map(({ key, label }) => (
                <div key={key} className="rounded-lg bg-muted/50 px-2 py-1.5 text-center">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className="num mt-0.5 font-mono text-xs font-medium">
                    <Pct value={coin[key] as number} />
                  </p>
                </div>
              ))}
            </div>
          )}
        </SheetHeader>

        <div className="flex-1 space-y-4 px-5 py-4">
            {/* Live tracker */}
          <PositionTracker pair={pair} base={base || (coin?.symbol ?? "")} update={update} position={position} onSave={save} onLaunchBot={launchBot} />

          {/* V2 verdict — the seven filters, live for this pair */}
          {update?.v2 && (
            <div className="space-y-2">
              {update.v2.spreadBps != null && (
                <p>
                  <span
                    className={cn(
                      "num inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none",
                      update.v2.spreadBps > 15 ? "border-warn/40 text-warn" : "border-border text-muted-foreground",
                    )}
                    title="bid-ask spread in basis points — wider than 15 bps and the TP exit stops being honest"
                  >
                    spread {update.v2.spreadBps.toFixed(0)}bps
                  </span>
                </p>
              )}
              <V2Panel v2={update.v2} onLaunchBot={launchBotFromPlan} />
            </div>
          )}

          {/* Chart */}
          <PriceChart symbol={coin?.symbol ?? base ?? null} />

          {/* Recent signals */}
          {pair && (
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold">Recent radar signals</h3>
              {signals.isLoading ? (
                <div className="mt-2 h-16 animate-pulse rounded-lg bg-muted" />
              ) : mergedSignals.length > 0 ? (
                <ul className="mt-2 divide-y divide-border/60">
                  {mergedSignals.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 py-2 text-xs">
                      <span className="flex items-center gap-2">
                        <SignalTypeChip type={s.type} compact />
                        <span className="num font-mono text-muted-foreground">
                          {new Date(s.createdAt).toLocaleTimeString([], { hour12: false })}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        {s.change60m !== null ? <Pct value={s.change60m} /> : <span className="text-[10px] text-muted-foreground">{s.status === "final" ? "—" : "live"}</span>}
                        {s.mfe !== null && (
                          <span className="num font-mono text-[10px] text-muted-foreground">MFE <Pct value={s.mfe} /></span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">No signals for this pair in the retained window — quiet tape.</p>
              )}
            </div>
          )}

          {/* Meta */}
          {coin && (
            <div className="space-y-3 rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold">About</h3>
              {detail.data?.description ? (
                <p className="text-xs leading-relaxed text-muted-foreground">{detail.data.description}</p>
              ) : (
                <p className="text-xs text-muted-foreground">No description available.</p>
              )}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">Market cap</dt>
                  <dd className="num font-mono">{formatCompact(coin.marketCap)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">24h volume</dt>
                  <dd className="num font-mono">{formatCompact(coin.volume24h)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Circulating</dt>
                  <dd className="num font-mono">{formatSupply(coin.circulating)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Max supply</dt>
                  <dd className="num font-mono">{formatSupply(coin.maxSupply)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">All-time high</dt>
                  <dd className="num font-mono">
                    {formatPrice(coin.athPrice)}
                    <span className="ml-1 text-muted-foreground">({formatDay(coin.athDate)})</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">From ATH</dt>
                  <dd><Pct value={coin.fromAth} /></dd>
                </div>
              </dl>
              {detail.data && (detail.data.website || detail.data.explorer || detail.data.whitepaper) && (
                <div className="flex flex-wrap gap-3 pt-1">
                  {[
                    ["Website", detail.data.website],
                    ["Explorer", detail.data.explorer],
                    ["Whitepaper", detail.data.whitepaper],
                  ]
                    .filter(([, href]) => href !== null)
                    .map(([label, href]) => (
                      <a
                        key={label}
                        href={href as string}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {label}
                        <ExternalLink className="size-3" aria-hidden="true" />
                      </a>
                    ))}
                </div>
              )}
              {detail.data && detail.data.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {detail.data.tags.map((tag) => (
                    <span key={tag} className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {detail.isError && (
            <p className="rounded-lg border border-down/40 bg-down-soft px-3 py-2 text-xs text-down">
              Coin details failed to load: {detail.error.message} — the live tracker and chart still work.
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
