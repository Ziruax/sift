"use client";

// ── Radar data source chain: server scanner → REST proxy → in-browser engine ─
//
// Three tiers, best one wins, upgrades happen automatically:
//
//   1. "live"      socket.io to the radar mini-service (sandbox / self-host).
//                  The 24/7 server-side scanner; N browsers share one feed.
//   2. "fallback"  REST polling of /api/radar (same scanner, no websocket).
//                  Covers gateways that strip websocket upgrades.
//   3. "local"     the in-browser engine (src/lib/market/local-radar.ts) —
//                  Binance's public websocket streams, no server at all.
//                  This is what makes the deployed (static) app fully live.
//
// A fast probe decides the tier within seconds; the socket.io client keeps
// retrying forever, so the moment the server scanner reappears the app
// upgrades back to it and the local engine stands down.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import type { MarketSignal, PairUpdate, RadarSnapshot } from "@/lib/market/types";
import {
  getLocalRadar,
  getLocalSignals,
  subscribeLocalSignals,
} from "@/lib/market/local-radar";

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

export type ConnectionState = "connecting" | "live" | "reconnecting" | "fallback" | "local";

type Mode = "none" | "socket" | "rest" | "local";
let currentMode: Mode = "none";

// Pair-update fan-out: both the socket and the local engine feed the same
// subscribers (the coin sheet's live tracker), so the UI never cares which
// tier is active.
const pairUpdateListeners = new Set<(u: PairUpdate) => void>();
function emitPairUpdate(u: PairUpdate) {
  for (const cb of pairUpdateListeners) cb(u);
}

// Pairs subscribed by the coin sheet(s) — replayed into the local engine if
// the tier switches underneath them.
const subscribedPairs = new Set<string>();

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
    let restTimer: ReturnType<typeof setInterval> | null = null;
    let restFailures = 0;
    let probeTimer: ReturnType<typeof setTimeout> | null = null;
    let localGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const socket = getRadarSocket();
    const localRadar = getLocalRadar();
    currentMode = "none";

    const stopRest = () => {
      if (restTimer) {
        clearInterval(restTimer);
        restTimer = null;
      }
    };

    const setMode = (mode: Mode, conn: ConnectionState) => {
      currentMode = mode;
      if (!disposed) setState(conn);
    };

    const handleLocalSignal = (signal: MarketSignal) => {
      if (disposed || currentMode !== "local") return;
      setRecentSignals((prev) => [signal, ...prev.filter((s) => s.id !== signal.id)].slice(0, 100));
      signalHandler.current?.(signal);
    };

    // Wire the local engine once: snapshots and signals only flow to the UI
    // while the engine tier is active; pair updates always flow.
    localRadar.setListeners({
      onSnapshot: (s) => {
        if (!disposed && currentMode === "local") setSnapshot(s);
      },
      onSignal: handleLocalSignal,
      onPairUpdate: emitPairUpdate,
    });

    const startLocal = () => {
      if (disposed || currentMode === "local") return;
      stopRest();
      setMode("local", "local");
      // Stand the socket.io client down — without a backend it would retry
      // (and fetch junk) forever in the background. The recovery probe
      // reconnects it if a server scanner ever appears.
      try {
        if (!socket.connected) socket.close();
      } catch {
        /* ignore */
      }
      for (const pair of subscribedPairs) localRadar.subscribePair(pair);
      localRadar.start();
      setRecentSignals(getLocalSignals().slice(0, 100));
    };

    const stopLocal = () => {
      localRadar.stop();
    };

    const startRest = () => {
      if (disposed || restTimer) return;
      setMode("rest", "fallback");
      restFailures = 0;
      const poll = async () => {
        try {
          const res = await fetch("/api/radar", { cache: "no-store", signal: AbortSignal.timeout(6000) });
          if (!res.ok) throw new Error(String(res.status));
          const data = (await res.json()) as RadarSnapshot;
          if (disposed) return;
          restFailures = 0;
          if (currentMode === "rest") setSnapshot(data);
        } catch {
          restFailures += 1;
          // Two consecutive failures → the server scanner is gone; the
          // browser engine takes over.
          if (restFailures >= 2 && currentMode === "rest") startLocal();
        }
      };
      void poll();
      restTimer = setInterval(poll, 6000);
    };

    const onConnect = () => {
      if (disposed) return;
      stopRest();
      if (currentMode === "local") stopLocal();
      setMode("socket", "live");
    };
    const onDisconnect = () => {
      if (disposed) return;
      if (currentMode === "socket") {
        setState("reconnecting");
        // Keep data flowing from the REST proxy while the socket retries.
        startRest();
      }
    };
    const onSnapshot = (data: RadarSnapshot) => {
      if (!disposed && currentMode === "socket") setSnapshot(data);
    };
    const onRecent = (data: MarketSignal[]) => {
      if (!disposed && currentMode === "socket") setRecentSignals(data);
    };
    const onNewSignal = (data: MarketSignal) => {
      if (disposed || currentMode !== "socket") return;
      setRecentSignals((prev) => [data, ...prev.filter((s) => s.id !== data.id)].slice(0, 100));
      signalHandler.current?.(data);
    };
    const onPairUpdateSocket = (data: PairUpdate) => emitPairUpdate(data);

    if (socket.connected) onConnect();
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("radar:snapshot", onSnapshot);
    socket.on("signals:recent", onRecent);
    socket.on("signal:new", onNewSignal);
    socket.on("pair:update", onPairUpdateSocket);

    // Local signal log changes (grading updates arrive continuously).
    const unsubscribeLocalLog = subscribeLocalSignals(() => {
      if (!disposed && currentMode === "local") setRecentSignals(getLocalSignals().slice(0, 100));
    });

    // Fast probe: does a server-side scanner exist at all? Decides the tier
    // within a couple of seconds instead of blind-waiting on the socket.
    probeTimer = setTimeout(async () => {
      try {
        const res = await fetch("/api/radar", { cache: "no-store", signal: AbortSignal.timeout(2500) });
        if (!res.ok) throw new Error(String(res.status));
        if (disposed) return;
        const data = (await res.json()) as RadarSnapshot;
        if (!socket.connected && currentMode !== "socket") {
          setSnapshot(data);
          startRest();
        }
      } catch {
        if (disposed || socket.connected || currentMode === "local") return;
        // No backend scanner answering — give the socket a short grace
        // period, then light up the in-browser engine.
        localGraceTimer = setTimeout(() => {
          if (!disposed && !socket.connected) startLocal();
        }, 2500);
      }
    }, 800);

    // Local-tier recovery: if the browser engine is running but a server
    // scanner comes back, upgrade. (The socket.io client also reconnects on
    // its own, which upgrades to tier 1 directly.)
    const recoveryTimer = setInterval(async () => {
      if (disposed || currentMode !== "local") return;
      try {
        const res = await fetch("/api/radar", { cache: "no-store", signal: AbortSignal.timeout(2500) });
        if (res.ok && !socket.connected) {
          // A scanner answered — bring the socket back up; if it connects
          // the onConnect handler upgrades us to the live tier.
          try {
            socket.connect();
          } catch {
            /* ignore */
          }
          localRadar.stop();
          startRest();
        }
      } catch {
        /* stay on the local engine */
      }
    }, 60_000);

    return () => {
      disposed = true;
      if (probeTimer) clearTimeout(probeTimer);
      if (localGraceTimer) clearTimeout(localGraceTimer);
      clearInterval(recoveryTimer);
      stopRest();
      if (currentMode === "local") stopLocal();
      currentMode = "none";
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("radar:snapshot", onSnapshot);
      socket.off("signals:recent", onRecent);
      socket.off("signal:new", onNewSignal);
      socket.off("pair:update", onPairUpdateSocket);
      unsubscribeLocalLog();
    };
  }, []);

  const subscribePair = useCallback((pair: string) => {
    const clean = pair.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!clean) return;
    subscribedPairs.add(clean);
    getRadarSocket().emit("pair:subscribe", { pair: clean });
    if (currentMode === "local") getLocalRadar().subscribePair(clean);
  }, []);

  const unsubscribePair = useCallback((pair: string) => {
    const clean = pair.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!clean) return;
    subscribedPairs.delete(clean);
    getRadarSocket().emit("pair:unsubscribe", { pair: clean });
    if (currentMode === "local") getLocalRadar().unsubscribePair(clean);
  }, []);

  return { snapshot, state, recentSignals, subscribePair, unsubscribePair };
}

// Subscribes to a single pair's live stream (the position tracker). Returns
// null until the first update lands; `exists: false` on the update means
// "Binance has no USDT pair for this coin". Works in every tier: the fan-out
// set is fed by both the socket and the local engine.
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
    const handler = (data: PairUpdate) => {
      if (data.pair.toUpperCase() === normalized) setUpdate(data);
    };
    pairUpdateListeners.add(handler);
    return () => {
      pairUpdateListeners.delete(handler);
      unsubscribe(normalized);
    };
  }, [normalized, subscribe, unsubscribe]);

  return update;
}

/** The in-browser engine's signal log, reactive — merged into the Signals tab. */
const NO_SIGNALS: MarketSignal[] = [];
export function useLocalSignals(): MarketSignal[] {
  return useSyncExternalStore(subscribeLocalSignals, getLocalSignals, () => NO_SIGNALS);
}
