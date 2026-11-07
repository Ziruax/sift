"use client";

// ── Sift notification center ─────────────────────────────────────────────────
//
// One place for everything that needs the user's attention RIGHT NOW:
// radar signals, bot range hits and system notices. Every notification is
//   1. recorded in a localStorage-backed log (the bell in the header),
//   2. turned into a toast when the tab is visible,
//   3. turned into a native browser notification when the tab is hidden,
//   4. paired with a synthesized sound (WebAudio — no audio files needed).
//
// Everything degrades gracefully: no permission → no browser notifications,
// autoplay blocked → no sound, storage blocked → in-memory log. The app
// itself never depends on any of this succeeding.

import { useCallback, useSyncExternalStore } from "react";

export type NotificationKind = "signal" | "bot" | "system";
export type NotificationTone = "up" | "down" | "warn" | "info";

export type AppNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  ts: number; // epoch ms
  read: boolean;
  tone: NotificationTone;
  pair?: string;
  botId?: string;
};

export type NotifySettings = {
  sound: boolean;
  browser: boolean; // native browser notifications when the tab is hidden
};

const LIST_KEY = "sift:notifications:v1";
const SETTINGS_KEY = "sift:notify-settings:v1";
const MAX_NOTIFICATIONS = 120;

const DEFAULT_SETTINGS: NotifySettings = { sound: true, browser: true };

// ── Store (localStorage + in-memory fallback) ────────────────────────────────

let cachedList: AppNotification[] | null = null;
let cachedSettings: NotifySettings | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function readList(): AppNotification[] {
  if (cachedList === null) {
    try {
      const raw = localStorage.getItem(LIST_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      cachedList = Array.isArray(parsed)
        ? parsed
            .filter((n): n is AppNotification => !!n && typeof n === "object" && typeof (n as AppNotification).id === "string")
            .slice(0, MAX_NOTIFICATIONS)
        : [];
    } catch {
      cachedList = [];
    }
  }
  return cachedList;
}

function writeList(next: AppNotification[]) {
  cachedList = next.slice(0, MAX_NOTIFICATIONS);
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(cachedList));
  } catch {
    /* storage full or blocked — the in-memory log still works */
  }
  emit();
}

function readSettings(): NotifySettings {
  if (cachedSettings === null) {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      cachedSettings =
        parsed && typeof parsed === "object"
          ? {
              sound: typeof (parsed as NotifySettings).sound === "boolean" ? (parsed as NotifySettings).sound : true,
              browser: typeof (parsed as NotifySettings).browser === "boolean" ? (parsed as NotifySettings).browser : true,
            }
          : { ...DEFAULT_SETTINGS };
    } catch {
      cachedSettings = { ...DEFAULT_SETTINGS };
    }
  }
  return cachedSettings;
}

function writeSettings(next: NotifySettings) {
  cachedSettings = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* in-memory only */
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── Sound (WebAudio, lazily created, never throws) ───────────────────────────

let audioCtx: AudioContext | null = null;

function tone(freqs: number[], gainPeak = 0.14) {
  try {
    if (typeof window === "undefined") return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!audioCtx || audioCtx.state === "closed") audioCtx = new Ctor();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const ctx = audioCtx;
    const start = ctx.currentTime;
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const at = start + i * 0.16;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(gainPeak, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.16);
    });
  } catch {
    /* audio unavailable — silence is fine */
  }
}

// Tone recipes per notification type. Distinct enough to tell apart blind.
const TONES: Record<NotificationKind, number[]> = {
  bot: [880, 1318], // bright rising double-beep — "your range was hit"
  signal: [660], // short ping
  system: [440, 440], // neutral double
};

// ── Browser notifications ────────────────────────────────────────────────────
// Permission is exposed as an external store so React can read it with
// useSyncExternalStore — SSR-safe, no setState-in-effect.

const permissionListeners = new Set<() => void>();

function emitPermission() {
  for (const listener of permissionListeners) listener();
}

export function subscribePermission(listener: () => void): () => void {
  permissionListeners.add(listener);
  return () => {
    permissionListeners.delete(listener);
  };
}

export function getPermissionSnapshot(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestBrowserPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted" || Notification.permission === "denied") return Notification.permission;
  try {
    const result = await Notification.requestPermission();
    emitPermission();
    return result;
  } catch {
    return Notification.permission;
  }
}

// The permission can also change via the browser's own site-settings UI;
// re-read on focus/visibility so the bell reflects reality.
if (typeof window !== "undefined") {
  window.addEventListener("focus", emitPermission);
  document.addEventListener("visibilitychange", emitPermission);
}

function showBrowserNotification(n: AppNotification) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const native = new Notification(n.title, {
      body: n.body,
      tag: n.id, // replaces duplicates with the same id
      icon: "/logo.svg",
    });
    native.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      native.close();
    };
  } catch {
    /* notifications unavailable */
  }
}

// ── The one entry point ──────────────────────────────────────────────────────

export type NotifyInput = {
  kind: NotificationKind;
  title: string;
  body: string;
  tone?: NotificationTone;
  pair?: string;
  botId?: string;
  id?: string;
  /**
   * Toast factory — injected by the app (page.tsx) because only it knows how
   * to build interactive toasts (e.g. with a "Track" button). When omitted no
   * toast is shown; the notification center and native notifications still
   * fire. This keeps the library UI-framework-free.
   */
  toast?: () => void;
  /** Override the "only when hidden" rule for native notifications. */
  forceNative?: boolean;
};

export function notify(input: NotifyInput): AppNotification {
  const entry: AppNotification = {
    id: input.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind,
    title: input.title,
    body: input.body,
    ts: Date.now(),
    read: false,
    tone: input.tone ?? "info",
    pair: input.pair,
    botId: input.botId,
  };
  writeList([entry, ...readList()]);

  const settings = readSettings();
  const hidden = typeof document !== "undefined" && document.hidden;

  if (settings.sound) tone(TONES[input.kind] ?? TONES.system);
  if (input.toast) input.toast();
  if ((hidden || input.forceNative) && settings.browser) showBrowserNotification(entry);

  return entry;
}

// ── React hooks ──────────────────────────────────────────────────────────────

const EMPTY: AppNotification[] = [];

export function useNotifications() {
  const items = useSyncExternalStore(subscribe, readList, () => EMPTY);
  const unread = items.filter((n) => !n.read).length;

  const markAllRead = useCallback(() => {
    const list = readList();
    if (list.some((n) => !n.read)) writeList(list.map((n) => ({ ...n, read: true })));
  }, []);

  const markRead = useCallback((id: string) => {
    writeList(readList().map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const clearAll = useCallback(() => {
    writeList([]);
  }, []);

  return { items, unread, markAllRead, markRead, clearAll };
}

export function useNotifySettings() {
  const settings = useSyncExternalStore(subscribe, readSettings, () => DEFAULT_SETTINGS);

  const toggle = useCallback((key: keyof NotifySettings) => {
    writeSettings({ ...readSettings(), [key]: !readSettings()[key] });
  }, []);

  return { settings, toggle };
}

/** Live browser-notification permission, SSR-safe. */
export function useNotificationPermission(): NotificationPermission | "unsupported" {
  return useSyncExternalStore(subscribePermission, getPermissionSnapshot, () => "unsupported" as const);
}
