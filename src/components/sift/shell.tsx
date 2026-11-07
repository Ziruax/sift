"use client";

import { Radar, Moon, Sun, ArrowUpRight } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { LiveDot } from "./primitives";
import type { ConnectionState } from "@/hooks/use-radar-socket";

export type TabId = "radar" | "markets" | "signals" | "saved";

const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: "radar", label: "Radar", hint: "Live pump & dump radar" },
  { id: "markets", label: "Markets", hint: "The minute tape" },
  { id: "signals", label: "Signals", hint: "Every signal, graded by what happened next" },
  { id: "saved", label: "Saved", hint: "Your watchlist" },
];

const CONNECTION_COPY: Record<ConnectionState, { label: string; tone: "up" | "warn" | "down" }> = {
  connecting: { label: "Connecting", tone: "warn" },
  live: { label: "Live", tone: "up" },
  reconnecting: { label: "Reconnecting", tone: "warn" },
  fallback: { label: "Polling", tone: "warn" },
};

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className="grid size-9 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      aria-label="Toggle light and dark theme"
    >
      {/* Both icons render identically on server and client — the active one
          is chosen purely by the theme class, so hydration never mismatches. */}
      <Sun className="size-4 hidden dark:block" aria-hidden="true" />
      <Moon className="size-4 dark:hidden" aria-hidden="true" />
    </button>
  );
}

export function Shell({
  tab,
  onTab,
  connection,
  updatedAt,
  children,
  tabCounts,
}: {
  tab: TabId;
  onTab: (tab: TabId) => void;
  connection: ConnectionState;
  updatedAt: string | null;
  children: ReactNode;
  tabCounts?: Partial<Record<TabId, number>>;
}) {
  const conn = CONNECTION_COPY[connection];
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-h-11 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
              <ArrowUpRight className="size-5" strokeWidth={2.5} />
            </span>
            <span>
              <span className="block text-xl font-semibold leading-none tracking-tight">Sift</span>
              <span className="text-[11px] text-muted-foreground">market opportunity terminal</span>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <p className="flex min-h-9 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground" aria-live="polite">
              <LiveDot tone={conn.tone} pulse={connection === "live"} />
              <span className="hidden sm:inline">{conn.label}</span>
              <span className="num hidden font-mono md:inline">
                {updatedAt ? `scan ${new Date(updatedAt).toLocaleTimeString([], { hour12: false })}` : "…"}
              </span>
            </p>
            <ThemeToggle />
          </div>
        </div>
        <nav className="mx-auto w-full max-w-7xl px-4" aria-label="Main sections">
          <div role="tablist" className="-mb-px flex gap-1 overflow-x-auto">
            {TABS.map((t) => {
              const active = tab === t.id;
              const count = tabCounts?.[t.id];
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={active}
                  title={t.hint}
                  onClick={() => onTab(t.id)}
                  className={cn(
                    "relative flex min-h-11 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors",
                    active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.id === "radar" && <Radar className="size-3.5" aria-hidden="true" />}
                  {t.label}
                  {typeof count === "number" && count > 0 && (
                    <span className="num rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-28 sm:pb-6">{children}</main>

      <footer className="mt-auto border-t border-border bg-card/40">
        <div className="mx-auto w-full max-w-7xl px-4 py-4 text-[11px] leading-relaxed text-muted-foreground">
          <p>
            Radar and live prices from the public Binance spot feed, scanned server-side every 5 seconds — even while
            this tab is closed. The board and coin pages use CoinPaprika; history uses Binance klines with DeFiLlama as
            fallback. Signals are graded by what the price actually did 5, 15 and 60 minutes later.
          </p>
          <p className="mt-1">
            Not investment advice. Signals are observations, not predictions — a coin can dump 30% a minute after
            looking strong, and no score can foresee that.
          </p>
        </div>
      </footer>
    </div>
  );
}
