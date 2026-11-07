"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { MarketSignal, PairUpdate, RadarSnapshot } from "@/lib/market/types";

// One socket to the radar mini-service, shared by every consumer in the app.
// The path MUST stay "/" and the port travels in the query string — that is
// how the sandbox gateway forwards websocket traffic.
const SOCKET_URL = "/?XTransformPort=3003";

let socketSingleton: Socket | null = null;

export function getRadarSocket(): Socket {
  if (!socketSingleton) {
    socketSingleton = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 8000,
    });
  }
  return socketSingleton;
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "fallback";

type RadarSocketOptions = {
  onSignal?: (signal: MarketSignal) => void;
};

export function useRadarSocket({ onSignal }: RadarSocketOptions = {}) {
  const [snapshot, setSnapshot] = useState<RadarSnapshot | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [recentSignals, setRecentSignals] = useState<MarketSignal[]>([]);
  const signalHandler = useRef(onSignal);
  signalHandler.current = onSignal;

  useEffect(() => {
    let disposed = false;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    const socket = getRadarSocket();

    const startFallback = () => {
      if (fallbackTimer) return;
      setState("fallback");
      const poll = async () => {
        try {
          const res = await fetch("/api/radar", { cache: "no-store" });
          if (!res.ok) throw new Error(String(res.status));
          const data = (await res.json()) as RadarSnapshot;
          if (!disposed) setSnapshot(data);
        } catch {
          /* keep trying — the proxy reports when the service is down */
        }
      };
      void poll();
      fallbackTimer = setInterval(poll, 6000);
    };

    const stopFallback = () => {
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const onConnect = () => {
      if (disposed) return;
      stopFallback();
      setState("live");
    };
    const onDisconnect = () => {
      if (!disposed) setState("reconnecting");
    };
    const onSnapshot = (data: RadarSnapshot) => {
      if (!disposed) setSnapshot(data);
    };
    const onRecent = (data: MarketSignal[]) => {
      if (!disposed) setRecentSignals(data);
    };
    const onNewSignal = (data: MarketSignal) => {
      if (disposed) return;
      setRecentSignals((prev) => [data, ...prev.filter((s) => s.id !== data.id)].slice(0, 100));
      signalHandler.current?.(data);
    };

    if (socket.connected) onConnect();
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("radar:snapshot", onSnapshot);
    socket.on("signals:recent", onRecent);
    socket.on("signal:new", onNewSignal);

    // If the socket can't establish itself quickly, fall back to REST polling
    // so the radar still works when websockets are blocked entirely.
    const connectGuard = setTimeout(() => {
      if (!disposed && !socket.connected) startFallback();
    }, 9000);

    return () => {
      disposed = true;
      clearTimeout(connectGuard);
      stopFallback();
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("radar:snapshot", onSnapshot);
      socket.off("signals:recent", onRecent);
      socket.off("signal:new", onNewSignal);
    };
  }, []);

  const subscribePair = useCallback((pair: string) => {
    getRadarSocket().emit("pair:subscribe", { pair });
  }, []);

  const unsubscribePair = useCallback((pair: string) => {
    getRadarSocket().emit("pair:unsubscribe", { pair });
  }, []);

  return { snapshot, state, recentSignals, subscribePair, unsubscribePair };
}

// Subscribes to a single pair's live stream (the position tracker). Returns
// null until the first update lands; `exists: false` on the update means
// "Binance has no USDT pair for this coin".
export function usePairStream(
  pair: string | null,
  subscribe: (p: string) => void,
  unsubscribe: (p: string) => void,
) {
  const [update, setUpdate] = useState<PairUpdate | null>(null);
  const [seenPair, setSeenPair] = useState<string | null>(null);
  const normalized = pair !== null ? pair.toUpperCase() : null;

  // Derived reset during render (React pattern) — no setState inside effects.
  if (normalized !== seenPair) {
    setSeenPair(normalized);
    setUpdate(null);
  }

  useEffect(() => {
    if (!normalized) return;
    subscribe(normalized);
    const socket = getRadarSocket();
    const handler = (data: PairUpdate) => {
      if (data.pair.toUpperCase() === normalized) setUpdate(data);
    };
    socket.on("pair:update", handler);
    return () => {
      socket.off("pair:update", handler);
      unsubscribe(normalized);
    };
  }, [normalized, subscribe, unsubscribe]);

  return update;
}
