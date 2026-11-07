"use client";

// ── The bot engine — turns prices into instant notifications ─────────────────
//
// Runs while any bot is armed (watching / in_target). Two price paths, one
// goal: catch a range hit within seconds and confirm it before shouting.
//
//   1. REST poll loop — POST /api/bot/poll → FreeCryptoAPI (primary source,
//      per the product decision: the credits are spent ONLY on armed bots)
//      at a short cadence: 8s while the tab is visible, 45s while hidden.
//   2. Live tape ingestion — the radar's per-second prices call
//      ingestTapePrice(); the instant a boundary is crossed we fire a
//      TARGETED poll (just that symbol) so the notification is confirmed by
//      the REST feed, not just a flickering tick.
//
// State transitions:
//   watching ──price in target range──▶ in_target  (notification, once)
//   in_target ──price exits range +0.5% buffer──▶ watching (re-armed, logged)
//   watching/in_target ──price in stop range──▶ stopped (notification, terminal)
//   any ──expiry passed──▶ expired (logged, no more checks)
//
// Every fired alert goes through the notification center: sound + toast +
// native browser notification when the tab is hidden.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  applyBotUpdate,
  getBots,
  isBotActive,
  inRange,
  leftRange,
  useBots,
  type Bot,
  type BotEvent,
} from "@/lib/bots";
import { notify } from "@/lib/notifications";
import { formatPrice } from "@/lib/market/format";

const VISIBLE_MS = 8_000; // FreeCryptoAPI cadence while watching the app
const HIDDEN_MS = 45_000; // throttle when the tab is in the background
const CONFIRM_DEBOUNCE_MS = 1_500; // min gap between targeted confirm polls

export type BotEngineState = {
  running: boolean;
  lastPollAt: number | null;
  lastSource: "freecryptoapi" | "binance" | null;
  consecutiveErrors: number;
  notice: string | null; // e.g. quota failover message, shown in the UI
  lastError: string | null;
};

const INITIAL_STATE: BotEngineState = {
  running: false,
  lastPollAt: null,
  lastSource: null,
  consecutiveErrors: 0,
  notice: null,
  lastError: null,
};

// ── Engine (module singleton — one per browser tab) ──────────────────────────

class BotEngine {
  private state: BotEngineState = { ...INITIAL_STATE };
  private stateListeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private lastConfirmAt = 0;
  private openPairRef: ((pair: string) => void) | null = null;

  /** Injected by React so notifications can carry interactive toasts. */
  bind(openPair: (pair: string) => void) {
    this.openPairRef = openPair;
  }

  getState = (): BotEngineState => this.state;

  subscribeState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };

  private setState(patch: Partial<BotEngineState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener();
  }

  /** Call with the current bot list whenever it changes. */
  sync(active: Bot[], all: Bot[]): void {
    const shouldRun = active.length > 0;
    if (shouldRun && !this.state.running) {
      this.setState({ running: true, notice: null, lastError: null });
      void this.poll(true);
      this.schedule(2_000); // first re-check shortly after arming
    } else if (!shouldRun && this.state.running) {
      this.stop();
    } else if (shouldRun && this.timer === null) {
      this.schedule(1_000);
    }
    // Expiry sweep — cheap, runs on every store change.
    const now = Date.now();
    for (const bot of all) {
      if (isBotActive(bot) && bot.expiresAt !== null && now >= bot.expiresAt) {
        applyBotUpdate(bot.id, {
          status: "expired",
          events: [{ ts: now, kind: "expired", price: bot.lastPrice ?? bot.entry, note: "Bot expired." }],
        });
        this.fire({
          kind: "bot",
          tone: "info",
          title: `${bot.name} bot expired`,
          body: `The ${bot.pair} watcher reached its expiry without hitting a range.`,
          botId: bot.id,
          pair: bot.pair,
        });
      }
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.state.running) this.setState({ running: false });
  }

  private schedule(delay?: number): void {
    if (this.timer !== null) return; // already scheduled
    const hidden = typeof document !== "undefined" && document.hidden;
    const wait = delay ?? (hidden ? HIDDEN_MS : VISIBLE_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => {
        if (this.state.running) this.schedule();
      });
    }, wait);
  }

  /** A REST poll for all active bot symbols (or a targeted subset). */
  async poll(force = false, symbols?: string[]): Promise<void> {
    if (this.polling && !force) return;
    this.polling = true;
    try {
      const active = getBots().filter(isBotActive);
      if (active.length === 0) {
        this.stop();
        return;
      }
      const wanted = symbols ?? [...new Set(active.map((b) => b.base))].slice(0, 20);
      const response = await fetch("/api/bot/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbols: wanted }),
      });
      if (!response.ok) throw new Error(`poll responded ${response.status}`);
      const data = (await response.json()) as {
        ok: boolean;
        source: "freecryptoapi" | "binance";
        at: string;
        prices: Record<string, { price: number; change24h: number | null }>;
        missing?: string[];
        error?: string;
      };
      if (!data.ok) throw new Error("poll failed");
      this.setState({
        lastPollAt: Date.now(),
        lastSource: data.source,
        consecutiveErrors: 0,
        notice: data.error ?? null,
        lastError: null,
      });
      for (const bot of active) {
        const info = data.prices[bot.base];
        if (!info || !Number.isFinite(info.price) || info.price <= 0) continue;
        this.evaluate(bot, info.price, data.source, true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "poll failed";
      this.setState({
        consecutiveErrors: this.state.consecutiveErrors + 1,
        lastError: message,
      });
    } finally {
      this.polling = false;
    }
  }

  /**
   * Live tape prices (from the radar snapshot / pair streams). Instant path:
   * when a boundary is crossed we schedule a targeted REST confirm so the
   * FreeCryptoAPI feed validates the tick before the notification fires.
   */
  ingestTapePrices(rows: Array<{ pair: string; price: number }>): void {
    for (const row of rows) this.ingestTapePrice(row.pair, row.price);
  }

  ingestTapePrice(pair: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const normalized = pair.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const bots = getBots().filter((b) => b.pair === normalized && isBotActive(b));
    if (bots.length === 0) return;
    for (const bot of bots) {
      const boundaryHit =
        (bot.status === "watching" && (inRange(price, bot.targetLow, bot.targetHigh) || inRange(price, bot.stopLow, bot.stopHigh))) ||
        (bot.status === "in_target" && leftRange(price, bot.targetLow, bot.targetHigh));
      if (!boundaryHit) continue;
      const now = Date.now();
      if (now - this.lastConfirmAt < CONFIRM_DEBOUNCE_MS) continue; // a confirm is already in flight
      this.lastConfirmAt = now;
      // Targeted confirm poll — one symbol, one credit.
      void this.poll(true, [bot.base]);
      return; // one confirm per tape batch is plenty
    }
  }

  /** Evaluation: apply range transitions for one bot at one price. */
  private evaluate(bot: Bot, price: number, source: "freecryptoapi" | "binance" | "tape", countCheck: boolean): void {
    // Re-read the bot's CURRENT state — a concurrent poll (e.g. an instant
    // tape-triggered confirm racing the scheduled one) may have already
    // transitioned it, and a range entry must notify exactly once.
    const fresh = getBots().find((b) => b.id === bot.id);
    const current: Bot = fresh ?? bot;
    const now = Date.now();
    const events: BotEvent[] = [];
    let status: Bot["status"] = current.status;

    const hitTarget = inRange(price, current.targetLow, current.targetHigh);
    const hitStop = inRange(price, current.stopLow, current.stopHigh);

    if (current.status !== "stopped" && current.status !== "done" && current.status !== "expired" && hitStop) {
      status = "stopped";
      events.push({
        ts: now,
        kind: "entered_stop",
        price,
        source,
        note: `Price ${formatPrice(price)} entered your stop range — exit zone.`,
      });
      this.fire({
        kind: "bot",
        tone: "down",
        title: `STOP ZONE — ${current.name}`,
        body: `${current.pair} is at ${formatPrice(price)}, inside your stop range. Investment $${current.investment.toLocaleString()} — check it now.`,
        botId: current.id,
        pair: current.pair,
      });
    } else if (current.status === "watching" && hitTarget) {
      status = "in_target";
      events.push({
        ts: now,
        kind: "entered_target",
        price,
        source,
        note: `Price ${formatPrice(price)} entered your target range.`,
      });
      this.fire({
        kind: "bot",
        tone: "up",
        title: `TARGET ZONE — ${current.name}`,
        body: `${current.pair} is at ${formatPrice(price)}, inside your target range${current.investment > 0 ? ` ($${current.investment.toLocaleString()} in)` : ""}. Confirmed by ${source === "freecryptoapi" ? "FreeCryptoAPI" : "Binance"}.`,
        botId: current.id,
        pair: current.pair,
      });
    } else if (current.status === "in_target" && leftRange(price, current.targetLow, current.targetHigh)) {
      // Price left the zone by more than the buffer — re-arm and log it.
      status = "watching";
      events.push({
        ts: now,
        kind: "left_target",
        price,
        source,
        note: `Price ${formatPrice(price)} left the target range — bot re-armed.`,
      });
    }

    applyBotUpdate(bot.id, {
      status,
      price,
      source,
      events,
      countCheck,
    });
  }

  private fire(input: Parameters<typeof notify>[0]): void {
    const makeToast = () => {
      toast[input.tone === "down" ? "error" : input.tone === "up" ? "success" : "info"](input.title, {
        description: input.body,
        duration: 12_000,
        action:
          input.pair && this.openPairRef
            ? { label: "Open", onClick: () => this.openPairRef?.(input.pair as string) }
            : undefined,
      });
    };
    notify({ ...input, toast: makeToast, forceNative: input.kind === "bot" });
  }
}

// ── React binding ─────────────────────────────────────────────────────────────

let engine: BotEngine | null = null;
function getEngine(): BotEngine {
  if (!engine) engine = new BotEngine();
  return engine;
}

const subscribeEngine = (listener: () => void) => getEngine().subscribeState(listener);
const readEngine = () => getEngine().getState();

export function useBotEngine(openPair: (pair: string) => void): {
  state: BotEngineState;
  pollNow: () => void;
  ingestTapePrices: (rows: Array<{ pair: string; price: number }>) => void;
} {
  const state = useSyncExternalStore(subscribeEngine, readEngine, () => INITIAL_STATE);
  const { bots } = useBots();

  useEffect(() => {
    const e = getEngine();
    e.bind(openPair);
    e.sync(bots.filter(isBotActive), bots);
  }, [bots, openPair]);

  useEffect(() => {
    const onVisibility = () => {
      // Coming back to the tab: check immediately instead of waiting out the
      // hidden throttle.
      if (!document.hidden) void getEngine().poll(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const pollNow = useCallback(() => {
    void getEngine().poll(true);
  }, []);

  const ingestTapePrices = useCallback((rows: Array<{ pair: string; price: number }>) => {
    const e = getEngine();
    for (const row of rows) e.ingestTapePrice(row.pair, row.price);
  }, []);

  return { state, pollNow, ingestTapePrices };
}

/** Imperative access for non-React callers (page-level wiring). */
export function getBotEngine(): BotEngine {
  return getEngine();
}
