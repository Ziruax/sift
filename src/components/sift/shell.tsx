"use client";

import { Bell, BellOff, Radar, Moon, Sun, ArrowUpRight, Volume2, VolumeX, CheckCheck, Trash2, FlaskConical } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  requestBrowserPermission,
  useNotificationPermission,
  useNotifications,
  useNotifySettings,
  type AppNotification,
} from "@/lib/notifications";
import { LiveDot } from "./primitives";
import { BtcModeBar } from "./v2-primitives";
import type { ConnectionState } from "@/hooks/use-radar-socket";
import type { BtcContext } from "@/lib/market/types";
import { Bot as BotIcon } from "lucide-react";

export type TabId = "radar" | "markets" | "signals" | "bots" | "backtest" | "saved";

const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: "radar", label: "Radar", hint: "Live pump & dump radar — V2 filtered" },
  { id: "markets", label: "Markets", hint: "The minute tape" },
  { id: "signals", label: "Signals", hint: "Every signal, graded by what happened next" },
  { id: "bots", label: "Bots", hint: "Your investments and price ranges — instant alerts" },
  { id: "backtest", label: "Backtest", hint: "Replay the V2 filters on 30 days of history — the proof before the promise" },
  { id: "saved", label: "Saved", hint: "Your watchlist" },
];

const CONNECTION_COPY: Record<ConnectionState, { label: string; tone: "up" | "warn" | "down" }> = {
  connecting: { label: "Connecting", tone: "warn" },
  live: { label: "Live", tone: "up" },
  reconnecting: { label: "Reconnecting", tone: "warn" },
  fallback: { label: "Polling", tone: "warn" },
  local: { label: "Live · browser", tone: "up" },
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

// ── Notification bell + center ────────────────────────────────────────────────

function notificationIcon(n: AppNotification) {
  if (n.tone === "up") return <ArrowUpRight className="size-3.5 text-up" aria-hidden="true" />;
  if (n.tone === "down") return <ArrowUpRight className="size-3.5 rotate-45 text-down" aria-hidden="true" />;
  return <Bell className="size-3.5 text-muted-foreground" aria-hidden="true" />;
}

export function NotificationBell() {
  const { items, unread, markAllRead, clearAll } = useNotifications();
  const { settings, toggle } = useNotifySettings();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const permission = useNotificationPermission();

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const enableBrowser = () => {
    void requestBrowserPermission();
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) markAllRead();
        }}
        className="relative grid size-9 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`Notifications${unread > 0 ? ` — ${unread} unread` : ""}`}
        aria-expanded={open}
      >
        {settings.browser && permission === "granted" ? (
          <Bell className="size-4" aria-hidden="true" />
        ) : (
          <BellOff className="size-4" aria-hidden="true" />
        )}
        {unread > 0 && (
          <span
            className="num absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-primary px-1 font-mono text-[10px] font-bold leading-4 text-primary-foreground"
            aria-hidden="true"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notification center"
          className="absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <p className="text-xs font-semibold">Notifications</p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => toggle("sound")}
                className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={settings.sound ? "Mute alert sounds" : "Unmute alert sounds"}
                title={settings.sound ? "Sound on" : "Sound off"}
              >
                {settings.sound ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => toggle("browser")}
                className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={settings.browser ? "Disable browser notifications" : "Enable browser notifications"}
                title={settings.browser ? "Browser notifications on" : "Browser notifications off"}
              >
                {settings.browser ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                aria-label="Clear all notifications"
                title="Clear all"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </div>

          {settings.browser && permission === "default" && (
            <button
              type="button"
              onClick={enableBrowser}
              className="flex w-full items-center gap-2 border-b border-border bg-accent/10 px-3 py-2.5 text-left text-xs text-foreground transition-colors hover:bg-accent/20"
            >
              <Bell className="size-3.5 shrink-0 text-up" aria-hidden="true" />
              Allow browser notifications — get pinged even when this tab is in the background.
            </button>
          )}
          {settings.browser && permission === "denied" && (
            <p className="border-b border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              Browser notifications are blocked for this site — allow them in the browser&rsquo;s site settings to get
              background alerts. Sound and in-app alerts still work.
            </p>
          )}

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                Nothing yet — radar signals and bot range hits land here.
              </p>
            ) : (
              <ul className="divide-y divide-border/60">
                {items.slice(0, 40).map((n) => (
                  <li key={n.id} className={cn("px-3 py-2.5", !n.read && "bg-accent/5")}>
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0">{notificationIcon(n)}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold leading-snug">{n.title}</p>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{n.body}</p>
                        <p className="num mt-1 font-mono text-[10px] text-muted-foreground">
                          {new Date(n.ts).toLocaleTimeString([], { hour12: false })}
                          {n.kind === "bot" ? " · bot" : n.kind === "signal" ? " · radar" : ""}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {items.length > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              className="flex w-full items-center justify-center gap-1.5 border-t border-border px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <CheckCheck className="size-3" aria-hidden="true" />
              Mark all read
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────

export function Shell({
  tab,
  onTab,
  connection,
  updatedAt,
  children,
  tabCounts,
  btc,
  goLongCount,
}: {
  tab: TabId;
  onTab: (tab: TabId) => void;
  connection: ConnectionState;
  updatedAt: string | null;
  children: ReactNode;
  tabCounts?: Partial<Record<TabId, number>>;
  btc?: BtcContext | null;
  goLongCount?: number | null;
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
          <div className="flex items-center gap-2 sm:gap-3">
            <p className="flex min-h-9 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground" aria-live="polite">
              <LiveDot tone={conn.tone} pulse={connection === "live" || connection === "local"} />
              <span className="hidden sm:inline">{conn.label}</span>
              <span className="num hidden font-mono md:inline">
                {updatedAt ? `scan ${new Date(updatedAt).toLocaleTimeString([], { hour12: false })}` : "…"}
              </span>
            </p>
            <NotificationBell />
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
                  {t.id === "bots" && <BotIcon className="size-3.5" aria-hidden="true" />}
                  {t.id === "backtest" && <FlaskConical className="size-3.5" aria-hidden="true" />}
                  {t.label}
                  {typeof count === "number" && count > 0 && (
                    <span className="num rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </nav>
        <BtcModeBar btc={btc ?? null} longs={goLongCount ?? null} />
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-28 sm:pb-6">{children}</main>

      <footer className="mt-auto border-t border-border bg-card/40">
        <div className="mx-auto w-full max-w-7xl px-4 py-4 text-[11px] leading-relaxed text-muted-foreground">
          <p>
            Radar and live prices from Binance&rsquo;s public market streams — scanned server-side every 5 seconds where a
            scanner runs, or tick-by-tick in your browser when it doesn&rsquo;t. The board, coin pages and search read
            CoinPaprika directly from your device; charts use Binance klines with DeFiLlama as fallback; sentiment is the
            alternative.me Fear &amp; Greed index. V2 verdicts pass seven filters — momentum, dollar volume, order-book
            walls, trade count, buyer traps, BTC regime and a stablecoin veto — before saying go long or go short, and
            every go signal ships an ATR-sized stop and take-profit plan. Bots poll FreeCryptoAPI on a short cadence —
            only while you have armed ranges — for instant, confirmed price captures. Signals are graded by what the
            price actually did 5, 15 and 60 minutes later, and the Backtest tab replays the same filters over a month
            of history before you trust them with anything.
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
