"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { downsample, RANGE_LABEL } from "@/lib/market/format";
import type { HistoryResult, PricePoint, RangeKey } from "@/lib/market/types";

const RANGES: RangeKey[] = ["1d", "7d", "1m", "3m", "1y", "max"];

function useHistory(symbol: string | null, range: RangeKey) {
  return useQuery<HistoryResult>({
    queryKey: ["history", symbol, range],
    queryFn: async () => {
      const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol ?? "")}&range=${range}`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      return res.json() as Promise<HistoryResult>;
    },
    enabled: symbol !== null,
    staleTime: range === "1d" || range === "7d" ? 60_000 : 300_000,
  });

}

function fmtAxis(range: RangeKey, t: number): string {
  const d = new Date(t * 1000);
  if (range === "1d") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (range === "7d" || range === "1m") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { month: "short", year: "2-digit" });
}

export function PriceChart({ symbol }: { symbol: string | null }) {
  const [range, setRange] = useState<RangeKey>("1d");
  const { data, isLoading, isError, error } = useHistory(symbol, range);

  const points: PricePoint[] = data?.points ?? [];
  const up = points.length > 1 && (points[points.length - 1]?.c ?? 0) >= (points[0]?.c ?? 0);
  const stroke = up ? "var(--up)" : "var(--down)";
  const chart = points.length > 1 ? downsample(points, 240) : [];

  const lows = points.map((p) => p.l).filter(Number.isFinite);
  const highs = points.map((p) => p.h).filter(Number.isFinite);
  const domain: [number, number] | undefined =
    lows.length && highs.length ? [Math.min(...lows), Math.max(...highs)] : undefined;
  const padding = domain ? (domain[1] - domain[0]) * 0.06 : 0;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold">Price history</h3>
        <div role="group" aria-label="Chart range" className="flex rounded-lg border border-border p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              aria-pressed={range === r}
              className={cn(
                "min-h-8 rounded-md px-2.5 text-[11px] font-medium transition-colors",
                range === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <div className="h-64 px-1 pb-2 pt-4 sm:h-72">
        {isLoading && <div className="h-full animate-pulse rounded-lg bg-muted" />}
        {isError && (
          <div className="grid h-full place-items-center px-4 text-center text-xs text-muted-foreground">
            History unavailable: {error.message}
          </div>
        )}
        {!isError && !isLoading && chart.length < 2 && (
          <div className="grid h-full place-items-center px-4 text-center text-xs text-muted-foreground">
            No chart data for this range{data?.source === "none" ? " — neither Binance nor DeFiLlama lists it" : ""}.
          </div>
        )}
        {chart.length >= 2 && (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="t"
                tickFormatter={(t: number) => fmtAxis(range, t)}
                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                minTickGap={48}
              />
              <YAxis
                domain={[domain ? domain[0] - padding : "auto", domain ? domain[1] + padding : "auto"]}
                tickFormatter={(v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(3)}`)}
                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={64}
              />
              <Tooltip
                cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "3 3" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0]?.payload as PricePoint;
                  return (
                    <div className="num rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
                      <p className="font-mono text-foreground">${p.c < 0.01 ? p.c.toPrecision(4) : p.c.toFixed(p.c < 100 ? 4 : 2)}</p>
                      <p className="mt-0.5 text-muted-foreground">
                        {new Date(p.t * 1000).toLocaleString([], { hour12: false })}
                      </p>
                    </div>
                  );
                }}
              />
              <Area type="monotone" dataKey="c" stroke={stroke} strokeWidth={1.75} fill="url(#priceFill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      {data && chart.length >= 2 && (
        <p className="border-t border-border px-4 py-1.5 text-[10px] text-muted-foreground">
          {points.length.toLocaleString()} candles from {data.source === "binance" ? "Binance spot klines" : data.source === "llama" ? "DeFiLlama" : "Yahoo Finance"}
        </p>
      )}
    </div>
  );
}
