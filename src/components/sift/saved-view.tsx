"use client";

import { useQuery } from "@tanstack/react-query";
import { Star, X } from "lucide-react";
import type { Coin } from "@/lib/market/types";
import { formatCompact } from "@/lib/market/format";
import { getSaved } from "@/lib/market/client";
import { EmptyState, Pct, RowSkeleton } from "./primitives";

export function SavedView({
  ids,
  onRemove,
  onOpenCoin,
}: {
  ids: string[];
  onRemove: (id: string) => void;
  onOpenCoin: (id: string) => void;
}) {
  const { data, isLoading, isError, error } = useQuery<Coin[]>({
    queryKey: ["saved", ids.join(",")],
    queryFn: () => getSaved(ids),
    enabled: ids.length > 0,
    refetchInterval: 60_000,
  });

  if (ids.length === 0) {
    return (
      <EmptyState
        title="Nothing saved yet"
        body="Tap the star next to any coin on the Markets board — or in a coin page — to pin it here. The list lives in this browser; no account, no tracking."
      />
    );
  }

  return (
    <div className="space-y-3">
      {isLoading && <RowSkeleton rows={4} />}
      {isError && <EmptyState title="Saved coins couldn't be refreshed" body={error.message} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map((coin) => (
          <div key={coin.id} className="group relative overflow-hidden rounded-xl border border-border bg-card p-4">
            <button
              type="button"
              onClick={() => onOpenCoin(coin.id)}
              className="w-full text-left"
              aria-label={`Open ${coin.name}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-base font-semibold">{coin.symbol}</span>
                <span className="num font-mono text-sm">${coin.price < 0.01 ? coin.price.toPrecision(4) : coin.price.toFixed(2)}</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{coin.name}</p>
              <div className="mt-3 flex items-center justify-between gap-2 text-xs">
                <Pct value={coin.change24h} />
                <span className="num font-mono text-muted-foreground">{formatCompact(coin.volume24h)} vol</span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1 text-[11px]">
                <span className="flex justify-between gap-1 text-muted-foreground">1h <Pct value={coin.change1h} /></span>
                <span className="flex justify-between gap-1 text-muted-foreground">7d <Pct value={coin.change7d} /></span>
                <span className="flex justify-between gap-1 text-muted-foreground">30d <Pct value={coin.change30d} /></span>
              </div>
            </button>
            <button
              type="button"
              onClick={() => onRemove(coin.id)}
              className="absolute right-2 top-2 grid size-8 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-down focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100"
              aria-label={`Remove ${coin.symbol} from watchlist`}
            >
              <X className="size-4" />
            </button>
            <Star className="pointer-events-none absolute left-0 top-0 size-3 fill-warn text-warn" aria-hidden="true" />
          </div>
        ))}
      </div>
      {data && data.length === 0 && (
        <EmptyState title="Saved coins aren't on the tape right now" body="They may have been delisted from the price feed. Try re-adding them from the Markets board." />
      )}
    </div>
  );
}
