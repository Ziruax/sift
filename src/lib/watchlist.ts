"use client";

import { useCallback, useSyncExternalStore } from "react";

// localStorage-backed state via useSyncExternalStore — the React-sanctioned
// way to read an external system without hydration mismatches or setState-in-
// effect cascades. The server snapshot is empty; the real list appears right
// after hydration.

const KEY = "sift:watchlist:v2";
const EMPTY: string[] = [];

// ── Watchlist store ─────────────────────────────────────────────────────────

let watchlistCache: string[] | null = null;
const watchlistListeners = new Set<() => void>();

function readWatchlist(): string[] {
  if (watchlistCache === null) {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      watchlistCache = Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string").slice(0, 60)
        : [];
    } catch {
      watchlistCache = [];
    }
  }
  return watchlistCache;
}

function writeWatchlist(next: string[]) {
  watchlistCache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked — in-memory list still works this session */
  }
  for (const listener of watchlistListeners) listener();
}

function subscribeWatchlist(listener: () => void): () => void {
  watchlistListeners.add(listener);
  return () => {
    watchlistListeners.delete(listener);
  };
}

export function useWatchlist() {
  const ids = useSyncExternalStore(subscribeWatchlist, readWatchlist, () => EMPTY);

  const toggle = useCallback((id: string) => {
    const current = readWatchlist();
    writeWatchlist(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  }, []);

  const remove = useCallback((id: string) => {
    writeWatchlist(readWatchlist().filter((x) => x !== id));
  }, []);

  const has = useCallback((id: string) => readWatchlist().includes(id), []);

  return { ids, toggle, remove, has };
}

// ── Position tracker store (per Binance pair) ───────────────────────────────
//
// Position tracker state, per coin, in localStorage — same honesty as the
// original: no accounts, no fake cloud sync, the device remembers.

export type TrackedPosition = {
  investment: number;
  entry: number;
  direction: "long" | "short";
  takeProfit: number;
  stopLoss: number;
};

const DEFAULT_POSITION: TrackedPosition = {
  investment: 10,
  entry: 0,
  direction: "long",
  takeProfit: 0,
  stopLoss: 0,
};

let positionPair: string | null = null;
let positionValue: TrackedPosition | null = null;
const positionListeners = new Set<() => void>();

function readPosition(pair: string): TrackedPosition | null {
  if (positionPair !== pair) {
    positionPair = pair;
    try {
      const raw = localStorage.getItem(`sift:position:${pair}`);
      positionValue = raw ? (JSON.parse(raw) as TrackedPosition) : { ...DEFAULT_POSITION };
    } catch {
      positionValue = { ...DEFAULT_POSITION };
    }
  }
  return positionValue;
}

function subscribePosition(listener: () => void): () => void {
  positionListeners.add(listener);
  return () => {
    positionListeners.delete(listener);
  };
}

export function usePosition(pair: string | null) {
  const normalized = pair !== null ? pair.toUpperCase() : null;
  const position = useSyncExternalStore(
    subscribePosition,
    () => (normalized === null ? null : readPosition(normalized)),
    () => null,
  );

  const save = useCallback(
    (next: TrackedPosition) => {
      if (normalized === null) return;
      readPosition(normalized); // ensure the cache is for this pair
      positionValue = next;
      try {
        localStorage.setItem(`sift:position:${normalized}`, JSON.stringify(next));
      } catch {
        /* keep in memory */
      }
      for (const listener of positionListeners) listener();
    },
    [normalized],
  );

  return { position, save };
}
