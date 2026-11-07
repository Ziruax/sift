"use client";

import { useQuery } from "@tanstack/react-query";
import { Search, Star, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { changeOf, formatCompact, MOVER_HINT, MOVER_LABEL, moverSignalFor, WINDOW_LABEL } from "@/lib/market/format";
import type { Board, BookKey, Coin, WindowKey } from "@/lib/market/types";
import { EmptyState, Pct, RowSkeleton, Stat } from "./primitives";

function useDebounced(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

function useBoard(window: WindowKey, book: BookKey) {
  return useQuery<Board>({
    queryKey: ["board", window, book],
    queryFn: () => fetchJson<Board>(`/api/board?window=${window}&book=${book}`),
    refetchInterval: 60_000,
  });
}

function useSearch(q: string) {
  return useQuery<Coin[]>({
    queryKey: ["search", q],
    queryFn: () => fetchJson<Coin[]>(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 1,
    staleTime: 60_000,
  });
}

function CoinRow({
  coin,
  window,
  starred,
  onStar,
  onOpen,
}: {
  coin: Coin;
  window: WindowKey;
  starred: boolean;
  onStar: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const change = changeOf(coin, window);
  const mover = moverSignalFor(change, coin.change24h);
  return (
    <tr
      className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-accent/5"
      onClick={() => onOpen(coin.id)}
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpen(coin.id)}
    >
      <td className="py-2.5 pl-4 pr-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onStar(coin.id);
            }}
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-warn focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={starred ? `Remove ${coin.symbol} from watchlist` : `Add ${coin.symbol} to watchlist`}
            aria-pressed={starred}
          >
            <Star className={cn("size-4", starred && "fill-warn text-warn")} />
          </button>
          <div className="min-w-0">
            <span className="font-semibold">{coin.symbol}</span>
            <span className="ml-2 hidden max-w-40 truncate text-xs text-muted-foreground lg:inline">{coin.name}</span>
          </div>
        </div>
      </td>
      <td className="num px-3 py-2.5 text-right font-mono">${coin.price < 0.01 ? coin.price.toPrecision(4) : coin.price.toLocaleString("en-US", { maximumFractionDigits: coin.price < 10 ? 4 : 2 })}</td>
      <td className="px-3 py-2.5 text-right"><Pct value={change} /></td>
      <td className="px-3 py-2.5 text-right"><Pct value={coin.change24h} /></td>
      <td className="num px-3 py-2.5 text-right font-mono text-muted-foreground">{formatCompact(coin.volume24h)}</td>
      <td className="num px-3 py-2.5 text-right font-mono text-muted-foreground">{formatCompact(coin.marketCap)}</td>
      <td className="hidden px-3 py-2.5 md:table-cell">
        <span
          className="inline-flex items-center rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
          title={MOVER_HINT[mover]}
        >
          {MOVER_LABEL[mover]}
        </span>
      </td>
      <td className="py-2.5 pl-2 pr-4 text-right">
        <span className="num font-mono text-xs text-muted-foreground">#{coin.rank || "—"}</span>
      </td>
    </tr>
  );
}

export function MarketsView({
  onOpenCoin,
  isStarred,
  onToggleStar,
}: {
  onOpenCoin: (id: string) => void;
  isStarred: (id: string) => boolean;
  onToggleStar: (id: string) => void;
}) {
  const [window, setWindow] = useState<WindowKey>("15m");
  const [book, setBook] = useState<BookKey>("tradable");
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const debounced = useDebounced(query, 300);
  const boxRef = useRef<HTMLDivElement>(null);

  const board = useBoard(window, book);
  const search = useSearch(debounced.trim().toLowerCase());
  const showSearch = focused && query.trim().length >= 1;

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setFocused(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const g = board.data?.global;

  return (
    <div className="space-y-5">
      {/* Global stats */}
      <section aria-label="Global market stats" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Market cap" value={g ? formatCompact(g.marketCap) : "—"} change={g?.marketCapChange24h} />
        <Stat label="24h volume" value={g ? formatCompact(g.volume24h) : "—"} change={g?.volumeChange24h} />
        <Stat label="BTC dominance" value={g ? `${g.btcDominance.toFixed(1)}%` : "—"} />
        <Stat label="Tracked coins" value={g ? g.listed.toLocaleString() : "—"} />
      </section>

      {/* Search */}
      <div ref={boxRef} className="relative">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            placeholder="Search coins — name or symbol…"
            aria-label="Search coins"
            className="h-11 w-full rounded-xl border border-border bg-card pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
        </div>
        {showSearch && (
          <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg">
            {search.isLoading && <p className="px-3 py-2 text-xs text-muted-foreground">Searching…</p>}
            {search.isError && <p className="px-3 py-2 text-xs text-down">Search is unavailable: {search.error.message}</p>}
            {search.data && search.data.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">No matches for “{query}”.</p>
            )}
            {search.data?.map((coin) => (
              <button
                key={coin.id}
                type="button"
                onClick={() => {
                  setFocused(false);
                  setQuery("");
                  onOpenCoin(coin.id);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/10"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-semibold">{coin.symbol}</span>
                  <span className="truncate text-xs text-muted-foreground">{coin.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <Pct value={coin.change24h} />
                  <span className="num font-mono text-xs text-muted-foreground">${coin.price < 0.01 ? coin.price.toPrecision(4) : coin.price.toFixed(2)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Window + book selectors */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Change window" className="flex rounded-lg border border-border bg-card p-0.5">
          {(["15m", "30m", "1h"] as WindowKey[]).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              aria-pressed={window === w}
              className={cn(
                "min-h-9 rounded-md px-3 text-xs font-medium transition-colors",
                window === w ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Liquidity book" className="flex rounded-lg border border-border bg-card p-0.5">
          {(["tradable", "deep"] as BookKey[]).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBook(b)}
              aria-pressed={book === b}
              title={b === "tradable" ? "Volume ≥ $500K, cap ≥ $20M" : "Volume ≥ $5M, cap ≥ $250M"}
              className={cn(
                "min-h-9 rounded-md px-3 text-xs font-medium capitalize transition-colors",
                book === b ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {b}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{WINDOW_LABEL[window]} changes · {book === "tradable" ? "$500K+ volume" : "$5M+ volume"}</p>
        {board.data?.stale && <span className="rounded-md border border-warn/30 px-2 py-1 text-[11px] text-warn">serving cached tape</span>}
      </div>

      {/* Movers */}
      <section aria-label="Biggest movers" className="grid gap-4 lg:grid-cols-2">
        {(["rising", "falling"] as const).map((kind) => {
          const coins = board.data ? (kind === "rising" ? board.data.rising : board.data.falling) : [];
          const count = board.data ? (kind === "rising" ? board.data.risingCount : board.data.fallingCount) : 0;
          return (
            <div key={kind} className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                {kind === "rising" ? (
                  <TrendingUp className="size-4 text-up" aria-hidden="true" />
                ) : (
                  <TrendingDown className="size-4 text-down" aria-hidden="true" />
                )}
                <h3 className="text-sm font-semibold">{kind === "rising" ? "Rising" : "Falling"}</h3>
                {count > 0 && (
                  <span className="num rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{count} notable</span>
                )}
              </div>
              <ol className="divide-y divide-border/60">
                {board.isLoading && (
                  <div className="p-3"><RowSkeleton rows={5} /></div>
                )}
                {coins.slice(0, 10).map((coin, i) => {
                  const change = changeOf(coin, window);
                  return (
                    <li key={coin.id}>
                      <button
                        type="button"
                        onClick={() => onOpenCoin(coin.id)}
                        className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/5"
                      >
                        <span className="num w-4 shrink-0 font-mono text-xs text-muted-foreground">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{coin.symbol}</span>
                        <span className="num font-mono text-xs text-muted-foreground">{formatCompact(coin.volume24h)}</span>
                        <span className="w-16 text-right text-sm"><Pct value={change} /></span>
                      </button>
                    </li>
                  );
                })}
                {board.isError && coins.length === 0 && (
                  <div className="p-4">
                    <EmptyState title="Tape unavailable" body={board.error.message} />
                  </div>
                )}
              </ol>
            </div>
          );
        })}
      </section>

      {/* Full board */}
      <section aria-label="Top coins" className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-2.5">
          <h3 className="text-sm font-semibold">Top 100 · live</h3>
        </div>
        {board.isLoading ? (
          <div className="p-4"><RowSkeleton rows={8} /></div>
        ) : board.isError ? (
          <div className="p-4">
            <EmptyState title="Live prices are unavailable right now" body={board.error.message} />
          </div>
        ) : (
          <div className="max-h-[70vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="py-2.5 pl-4 pr-2 font-medium">Coin</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Price</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">{window}</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">24h</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Volume</th>
                  <th scope="col" className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Cap</th>
                  <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">Shape</th>
                  <th scope="col" className="py-2.5 pl-2 pr-4 text-right font-medium">Rank</th>
                </tr>
              </thead>
              <tbody>
                {board.data?.markets.map((coin) => (
                  <CoinRow
                    key={coin.id}
                    coin={coin}
                    window={window}
                    starred={isStarred(coin.id)}
                    onStar={onToggleStar}
                    onOpen={onOpenCoin}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          {board.data ? `Updated ${new Date(board.data.updatedAt).toLocaleTimeString([], { hour12: false })} · CoinPaprika feed` : ""}
        </p>
      </section>
    </div>
  );
}
