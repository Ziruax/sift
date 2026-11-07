"use client";

// ── Sift bots — investment + price-range watchers ────────────────────────────
//
// A bot is the user's money with an opinion: "I put $X in at entry E; wake me
// up the moment price enters my target range (or my stop range)." Bots live in
// localStorage on the user's device — same honesty as the watchlist and
// positions: no accounts, no fake cloud sync.
//
// While any bot is active the app polls the FreeCryptoAPI feed (through our
// /api/bot/poll proxy — the key never reaches the browser) on a short cadence
// AND reacts instantly to live tape prices, so range hits are caught within
// seconds and confirmed by the REST feed before the notification fires.

import { useCallback, useSyncExternalStore } from "react";

export type BotStatus =
  | "watching" // armed, price outside both ranges
  | "in_target" // price is inside the target range right now
  | "stopped" // stop range was hit — terminal until manually reset
  | "done" // manually closed
  | "expired"; // expiry passed — terminal

export type BotEventKind =
  | "created"
  | "check" // routine price check (kept sparse — only notable ones)
  | "entered_target"
  | "left_target"
  | "entered_stop"
  | "reset"
  | "closed"
  | "expired"
  | "error";

export type BotEvent = {
  ts: number;
  kind: BotEventKind;
  price: number;
  source?: "freecryptoapi" | "binance" | "tape";
  note?: string;
};

export type Bot = {
  id: string;
  pair: string; // e.g. "BTCUSDT" — the Binance pair we track
  base: string; // e.g. "BTC" — the FreeCryptoAPI symbol
  name: string; // display label, defaults to base
  investment: number; // USD committed
  entry: number; // entry price (reference for P&L)
  direction: "long" | "short";
  // Target range: fire "entered target zone" when price is inside [low, high].
  targetLow: number;
  targetHigh: number;
  // Stop range: optional exit zone. 0/0 = disabled. Terminal when hit.
  stopLow: number;
  stopHigh: number;
  note: string;
  status: BotStatus;
  createdAt: number;
  expiresAt: number | null; // epoch ms, null = no expiry
  checks: number; // total price checks received
  lastCheckAt: number | null;
  lastCheckSource: "freecryptoapi" | "binance" | "tape" | null;
  lastPrice: number | null;
  lastPriceAt: number | null;
  events: BotEvent[];
};

const KEY = "sift:bots:v1";
const MAX_EVENTS = 60;
const MAX_BOTS = 30;

const EMPTY: Bot[] = [];

// ── Store ─────────────────────────────────────────────────────────────────────

let cached: Bot[] | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function sanitizeBot(raw: unknown): Bot | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<Bot>;
  if (typeof b.id !== "string" || typeof b.pair !== "string" || typeof b.base !== "string") return null;
  const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const bot: Bot = {
    id: b.id,
    pair: b.pair.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    base: b.base.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 40) : (b.base ?? "").toUpperCase(),
    investment: Math.max(0, num(b.investment)),
    entry: Math.max(0, num(b.entry)),
    direction: b.direction === "short" ? "short" : "long",
    targetLow: Math.max(0, num(b.targetLow)),
    targetHigh: Math.max(0, num(b.targetHigh)),
    stopLow: Math.max(0, num(b.stopLow)),
    stopHigh: Math.max(0, num(b.stopHigh)),
    note: typeof b.note === "string" ? b.note.slice(0, 240) : "",
    status: (["watching", "in_target", "stopped", "done", "expired"] as const).includes(b.status as BotStatus)
      ? (b.status as BotStatus)
      : "watching",
    createdAt: num(b.createdAt, Date.now()),
    expiresAt: typeof b.expiresAt === "number" && b.expiresAt > 0 ? b.expiresAt : null,
    checks: Math.max(0, Math.floor(num(b.checks))),
    lastCheckAt: typeof b.lastCheckAt === "number" ? b.lastCheckAt : null,
    lastCheckSource: (["freecryptoapi", "binance", "tape"] as const).includes(b.lastCheckSource as never)
      ? (b.lastCheckSource as Bot["lastCheckSource"])
      : null,
    lastPrice: typeof b.lastPrice === "number" && b.lastPrice > 0 ? b.lastPrice : null,
    lastPriceAt: typeof b.lastPriceAt === "number" ? b.lastPriceAt : null,
    events: Array.isArray(b.events)
      ? b.events
          .filter((e) => !!e && typeof e === "object" && typeof (e as BotEvent).ts === "number")
          .slice(-MAX_EVENTS)
      : [],
  };
  if (!bot.pair || !bot.base) return null;
  return bot;
}

function read(): Bot[] {
  if (cached === null) {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      cached = Array.isArray(parsed) ? parsed.flatMap((b) => { const bot = sanitizeBot(b); return bot ? [bot] : []; }) : [];
    } catch {
      cached = [];
    }
  }
  return cached;
}

function write(next: Bot[]) {
  cached = next.slice(0, MAX_BOTS);
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    /* storage full or blocked — in-memory still works this session */
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── Mutations ─────────────────────────────────────────────────────────────────

function withEvent(bot: Bot, event: BotEvent): Bot {
  return { ...bot, events: [...bot.events, event].slice(-MAX_EVENTS) };
}

export type BotDraft = Omit<Bot, "id" | "status" | "createdAt" | "checks" | "lastCheckAt" | "lastCheckSource" | "lastPrice" | "lastPriceAt" | "events">;

export function addBot(draft: BotDraft): Bot {
  const bot: Bot = {
    ...draft,
    pair: draft.pair.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    base: draft.base.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    id: `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    status: "watching",
    createdAt: Date.now(),
    checks: 0,
    lastCheckAt: null,
    lastCheckSource: null,
    lastPrice: null,
    lastPriceAt: null,
    events: [],
  };
  const created = withEvent(bot, { ts: Date.now(), kind: "created", price: draft.entry, note: "Bot armed." });
  write([created, ...read()]);
  return created;
}

export function updateBot(id: string, patch: Partial<Bot>): void {
  write(read().map((b) => (b.id === id ? sanitizeBot({ ...b, ...patch, id: b.id }) ?? b : b)));
}

export function removeBot(id: string): void {
  write(read().filter((b) => b.id !== id));
}

/** Engine-only update path: record a price check and status transitions. */
export function applyBotUpdate(
  id: string,
  patch: {
    status?: BotStatus;
    price?: number;
    source?: "freecryptoapi" | "binance" | "tape";
    events?: BotEvent[];
    countCheck?: boolean;
  },
): void {
  const list = read();
  const idx = list.findIndex((b) => b.id === id);
  if (idx === -1) return;
  const prev = list[idx] as Bot;
  const events = [...prev.events, ...(patch.events ?? [])].slice(-MAX_EVENTS);
  const next: Bot = {
    ...prev,
    status: patch.status ?? prev.status,
    lastPrice: patch.price ?? prev.lastPrice,
    lastPriceAt: patch.price !== undefined ? Date.now() : prev.lastPriceAt,
    lastCheckAt: patch.countCheck ? Date.now() : prev.lastCheckAt,
    lastCheckSource: patch.source ?? prev.lastCheckSource,
    checks: patch.countCheck ? prev.checks + 1 : prev.checks,
    events,
  };
  const nextList = [...list];
  nextList[idx] = next;
  write(nextList);
}

export function resetBot(id: string): void {
  const list = read();
  const idx = list.findIndex((b) => b.id === id);
  if (idx === -1) return;
  const prev = list[idx] as Bot;
  const next = withEvent({ ...prev, status: "watching" }, { ts: Date.now(), kind: "reset", price: prev.lastPrice ?? prev.entry, note: "Re-armed." });
  const nextList = [...list];
  nextList[idx] = next;
  write(nextList);
}

export function closeBot(id: string): void {
  const list = read();
  const idx = list.findIndex((b) => b.id === id);
  if (idx === -1) return;
  const prev = list[idx] as Bot;
  const next = withEvent({ ...prev, status: "done" }, { ts: Date.now(), kind: "closed", price: prev.lastPrice ?? prev.entry, note: "Closed by you." });
  const nextList = [...list];
  nextList[idx] = next;
  write(nextList);
}

// ── Derived helpers (shared by the engine and the UI) ────────────────────────

export const ACTIVE_STATUSES: BotStatus[] = ["watching", "in_target"];

export function isBotActive(bot: Bot): boolean {
  return ACTIVE_STATUSES.includes(bot.status);
}

/** Price is inside [low, high]; a disabled range (0/0) never matches. */
export function inRange(price: number, low: number, high: number): boolean {
  if (low <= 0 || high <= 0 || price <= 0) return false;
  return price >= Math.min(low, high) && price <= Math.max(low, high);
}

/** Has the price moved outside the range by more than `bufferPct` — re-arm gate. */
export function leftRange(price: number, low: number, high: number, bufferPct = 0.5): boolean {
  if (low <= 0 || high <= 0 || price <= 0) return false;
  const lo = Math.min(low, high);
  const hi = Math.max(low, high);
  return price < lo * (1 - bufferPct / 100) || price > hi * (1 + bufferPct / 100);
}

/** Progress 0..100 from entry toward the nearest edge of a range. */
export function rangeProgress(entry: number, price: number, low: number, high: number): number {
  if (low <= 0 || high <= 0 || entry <= 0 || price <= 0) return 0;
  const lo = Math.min(low, high);
  const hi = Math.max(low, high);
  const goingUp = hi >= entry; // range above entry → progress tracks upward moves
  const start = goingUp ? entry : entry;
  const edge = goingUp ? lo : hi; // the edge price must cross to enter the zone
  const total = Math.abs(edge - start);
  if (total === 0) return 100;
  const moved = goingUp ? price - start : start - price;
  return Math.max(0, Math.min(100, (moved / total) * 100));
}

/** Live P&L in USD for the invested amount. */
export function botPnl(bot: Bot, price: number): { usd: number; pct: number; value: number } {
  if (bot.entry <= 0 || price <= 0 || bot.investment <= 0) return { usd: 0, pct: 0, value: bot.investment };
  const units = bot.investment / bot.entry;
  const usd = bot.direction === "long" ? (price - bot.entry) * units : (bot.entry - price) * units;
  const value = bot.direction === "long" ? units * price : bot.investment + usd;
  return { usd, pct: (usd / bot.investment) * 100, value };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useBots() {
  const bots = useSyncExternalStore(subscribe, read, () => EMPTY);
  const active = bots.filter(isBotActive);
  return { bots, active, addBot, updateBot, removeBot, resetBot, closeBot };
}

/** Imperative read access for the engine (non-React callers). */
export function getBots(): Bot[] {
  return read();
}

// ── Prefill handoff (coin sheet → bot form) ─────────────────────────────────
//
// "Arm bot" on a coin sheet fires while the Bots view is not yet mounted, so
// a bare CustomEvent would be lost. The prefill is also queued here; the
// create form drains the queue the moment it mounts.

export type BotPrefill = {
  pair: string;
  base: string;
  investment: number;
  entry: number;
  direction: "long" | "short";
  targetLow: number;
  targetHigh: number;
  stopLow: number;
  stopHigh: number;
  note: string;
};

let pendingPrefill: BotPrefill | null = null;

export function queueBotPrefill(prefill: BotPrefill): void {
  pendingPrefill = prefill;
}

export function takeBotPrefill(): BotPrefill | null {
  const taken = pendingPrefill;
  pendingPrefill = null;
  return taken;
}
