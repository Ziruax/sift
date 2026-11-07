"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Shell, type TabId } from "@/components/sift/shell";
import { RadarView } from "@/components/sift/radar-view";
import { MarketsView } from "@/components/sift/markets-view";
import { SignalsView } from "@/components/sift/signals-view";
import { BotsView } from "@/components/sift/bots-view";
import { SavedView } from "@/components/sift/saved-view";
import { CoinSheet, type CoinTarget } from "@/components/sift/coin-sheet";
import { useRadarSocket } from "@/hooks/use-radar-socket";
import { useBotEngine, getBotEngine } from "@/hooks/use-bot-engine";
import { useBots } from "@/lib/bots";
import { useWatchlist } from "@/lib/watchlist";
import { notify } from "@/lib/notifications";
import { SIGNAL_META } from "@/lib/market/format";
import type { MarketSignal } from "@/lib/market/types";

export default function Page() {
  const [tab, setTab] = useState<TabId>("radar");
  const [target, setTarget] = useState<CoinTarget>(null);
  const [signalsRefreshKey, setSignalsRefreshKey] = useState(0);
  const watchlist = useWatchlist();
  const { active: activeBots } = useBots();

  const onSignal = useCallback((signal: MarketSignal) => {
    setSignalsRefreshKey((k) => k + 1);
    // Only surface the signals worth interrupting someone for.
    const worthIt =
      signal.score >= 70 &&
      signal.volume24h >= 5_000_000 &&
      (signal.type === "pump_start" || signal.type === "volume_lead" || signal.type === "dump_start");
    if (!worthIt) return;
    const meta = SIGNAL_META[signal.type];
    notify({
      kind: "signal",
      tone: meta.tone === "down" ? "down" : "up",
      title: `${signal.base} — ${meta.label}`,
      body: `Score ${signal.score} · ${signal.rvol.toFixed(1)}× volume · takers ${signal.buyPct.toFixed(0)}% buys`,
      pair: signal.pair,
      toast: () =>
        toast(`${signal.base} — ${meta.label}`, {
          description: `Score ${signal.score} · ${signal.rvol.toFixed(1)}× volume · takers ${signal.buyPct.toFixed(0)}% buys`,
          action: { label: "Track", onClick: () => setTarget({ kind: "pair", pair: signal.pair }) },
          duration: 9000,
        }),
    });
  }, []);

  const { snapshot, state, recentSignals, subscribePair, unsubscribePair } = useRadarSocket({ onSignal });
  const openPair = useCallback((pair: string) => setTarget({ kind: "pair", pair }), []);

  // The bot engine stays mounted for the whole app lifetime — armed bots must
  // keep watching and notifying no matter which tab is open. Every radar
  // snapshot feeds it live tape prices so range hits are caught the second
  // the tape crosses them, then confirmed by the FreeCryptoAPI poll.
  useBotEngine(openPair);
  useEffect(() => {
    if (!snapshot) return;
    getBotEngine().ingestTapePrices(snapshot.rows.map((r) => ({ pair: r.pair, price: r.price })));
  }, [snapshot]);

  const openCoin = useCallback((id: string) => setTarget({ kind: "id", id }), []);
  const closeSheet = useCallback(() => setTarget(null), []);

  // Radar price accessor for the Bots view — recreated per snapshot so the
  // bot cards tick with the live tape (page re-renders on every scan anyway).
  const livePrice = useCallback(
    (pair: string) => snapshot?.rows.find((r) => r.pair === pair.toUpperCase())?.price ?? null,
    [snapshot],
  );

  // Keyboard: Esc closes the coin sheet (Radix handles it); digits 1–5
  // switch tabs for power users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (target !== null || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const map: Record<string, TabId> = { "1": "radar", "2": "markets", "3": "signals", "4": "bots", "5": "saved" };
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
        bots: activeBots.length > 0 ? activeBots.length : undefined,
        saved: watchlist.ids.length > 0 ? watchlist.ids.length : undefined,
      }}
    >
      {tab === "radar" && <RadarView snapshot={snapshot} onOpenPair={openPair} />}
      {tab === "markets" && (
        <MarketsView onOpenCoin={openCoin} isStarred={watchlist.has} onToggleStar={watchlist.toggle} />
      )}
      {tab === "signals" && <SignalsView refreshKey={signalsRefreshKey} onOpenPair={openPair} />}
      {tab === "bots" && <BotsView livePrice={livePrice} onOpenPair={openPair} />}
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
        onNavigate={setTab}
      />
    </Shell>
  );
}
