"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Shell, type TabId } from "@/components/sift/shell";
import { RadarView } from "@/components/sift/radar-view";
import { MarketsView } from "@/components/sift/markets-view";
import { SignalsView } from "@/components/sift/signals-view";
import { SavedView } from "@/components/sift/saved-view";
import { CoinSheet, type CoinTarget } from "@/components/sift/coin-sheet";
import { useRadarSocket } from "@/hooks/use-radar-socket";
import { useWatchlist } from "@/lib/watchlist";
import { SIGNAL_META } from "@/lib/market/format";
import type { MarketSignal } from "@/lib/market/types";

export default function Page() {
  const [tab, setTab] = useState<TabId>("radar");
  const [target, setTarget] = useState<CoinTarget>(null);
  const [signalsRefreshKey, setSignalsRefreshKey] = useState(0);
  const watchlist = useWatchlist();

  const onSignal = useCallback((signal: MarketSignal) => {
    setSignalsRefreshKey((k) => k + 1);
    // Only surface the signals worth interrupting someone for.
    const worthIt =
      signal.score >= 70 &&
      signal.volume24h >= 5_000_000 &&
      (signal.type === "pump_start" || signal.type === "volume_lead" || signal.type === "dump_start");
    if (!worthIt) return;
    const meta = SIGNAL_META[signal.type];
    toast(`${signal.base} — ${meta.label}`, {
      description: `Score ${signal.score} · ${signal.rvol.toFixed(1)}× volume · takers ${signal.buyPct.toFixed(0)}% buys`,
      action: {
        label: "Track",
        onClick: () => setTarget({ kind: "pair", pair: signal.pair }),
      },
      duration: 9000,
    });
  }, []);

  const { snapshot, state, recentSignals, subscribePair, unsubscribePair } = useRadarSocket({ onSignal });

  const openCoin = useCallback((id: string) => setTarget({ kind: "id", id }), []);
  const openPair = useCallback((pair: string) => setTarget({ kind: "pair", pair }), []);
  const closeSheet = useCallback(() => setTarget(null), []);

  // Keyboard: Esc closes the coin sheet (Radix handles it), "/" focuses search
  // is a Markets nicety we skip; digits 1–4 switch tabs for power users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (target !== null || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const map: Record<string, TabId> = { "1": "radar", "2": "markets", "3": "signals", "4": "saved" };
      const next = map[e.key];
      if (next) setTab(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target]);

  const liveSignalsCount = recentSignals.filter((s) => s.status !== "final").length;

  return (
    <Shell
      tab={tab}
      onTab={setTab}
      connection={state}
      updatedAt={snapshot?.updatedAt ?? null}
      tabCounts={{
        signals: liveSignalsCount > 0 ? liveSignalsCount : undefined,
        saved: watchlist.ids.length > 0 ? watchlist.ids.length : undefined,
      }}
    >
      {tab === "radar" && <RadarView snapshot={snapshot} onOpenPair={openPair} />}
      {tab === "markets" && (
        <MarketsView onOpenCoin={openCoin} isStarred={watchlist.has} onToggleStar={watchlist.toggle} />
      )}
      {tab === "signals" && <SignalsView refreshKey={signalsRefreshKey} onOpenPair={openPair} />}
      {tab === "saved" && (
        <SavedView ids={watchlist.ids} onRemove={watchlist.remove} onOpenCoin={openCoin} />
      )}

      <CoinSheet
        target={target}
        onClose={closeSheet}
        subscribe={subscribePair}
        unsubscribe={unsubscribePair}
        isStarred={watchlist.has}
        onToggleStar={watchlist.toggle}
      />
    </Shell>
  );
}
