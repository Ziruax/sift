"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Shell, type TabId } from "@/components/sift/shell";
import { RadarView } from "@/components/sift/radar-view";
import { MarketsView } from "@/components/sift/markets-view";
import { SignalsView } from "@/components/sift/signals-view";
import { BotsView } from "@/components/sift/bots-view";
import { BacktestView } from "@/components/sift/backtest-view";
import { SavedView } from "@/components/sift/saved-view";
import { CoinSheet, type CoinTarget } from "@/components/sift/coin-sheet";
import { useRadarSocket } from "@/hooks/use-radar-socket";
import { useBotEngine, getBotEngine } from "@/hooks/use-bot-engine";
import { useBots, queueBotPrefill } from "@/lib/bots";
import { useWatchlist } from "@/lib/watchlist";
import { notify } from "@/lib/notifications";
import { SIGNAL_META } from "@/lib/market/format";
import type { MarketSignal, TradePlan } from "@/lib/market/types";

export default function Page() {
  const [tab, setTab] = useState<TabId>("radar");
  const [target, setTarget] = useState<CoinTarget>(null);
  const [signalsRefreshKey, setSignalsRefreshKey] = useState(0);
  const watchlist = useWatchlist();
  const { active: activeBots } = useBots();

  const onSignal = useCallback((signal: MarketSignal) => {
    setSignalsRefreshKey((k) => k + 1);
    // V2 go-signals are always worth interrupting someone for — that is the
    // entire point of the seven filters. Legacy signals still need to earn it.
    const isGo = signal.type === "go_long" || signal.type === "go_short";
    const worthIt =
      isGo ||
      (signal.score >= 70 &&
        signal.volume24h >= 5_000_000 &&
        (signal.type === "pump_start" || signal.type === "volume_lead" || signal.type === "dump_start"));
    if (!worthIt) return;
    const meta = SIGNAL_META[signal.type];
    notify({
      kind: "signal",
      tone: meta.tone === "down" ? "down" : "up",
      title: `${signal.base} — ${meta.label}`,
      body: isGo
        ? `${signal.note ?? `V2 score ${signal.score}`}`
        : `Score ${signal.score} · ${signal.rvol.toFixed(1)}× volume · takers ${signal.buyPct.toFixed(0)}% buys`,
      pair: signal.pair,
      toast: () =>
        toast(`${signal.base} — ${meta.label}`, {
          description: isGo
            ? (signal.note ?? `V2 score ${signal.score}`)
            : `Score ${signal.score} · ${signal.rvol.toFixed(1)}× volume · takers ${signal.buyPct.toFixed(0)}% buys`,
          action: { label: "Track", onClick: () => setTarget({ kind: "pair", pair: signal.pair }) },
          duration: isGo ? 15000 : 9000,
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

  // "Create bot from plan" on a radar row: hand the ATR-sized V2 trade plan to
  // the bot form as pre-filled ranges — target zone = TP1..TP2, stop zone
  // brackets the stop price.
  const launchBotFromPlan = useCallback(
    (pair: string, plan: TradePlan) => {
      const prefill = {
        pair,
        base: pair.replace(/USDT$/, ""),
        investment: 100,
        entry: plan.entry,
        direction: plan.side,
        targetLow: Math.min(plan.tp1, plan.tp2),
        targetHigh: Math.max(plan.tp1, plan.tp2),
        stopLow: Math.min(plan.stop * 0.9985, plan.stop),
        stopHigh: Math.max(plan.stop * 1.0015, plan.stop),
        note: `V2 ${plan.side} plan — stop ±${plan.riskPct.toFixed(2)}% sized to ${plan.atrPct !== null ? `${plan.atrPct.toFixed(2)}% ATR` : "default risk"}`,
      };
      queueBotPrefill(prefill);
      window.dispatchEvent(new CustomEvent("sift:prefill-bot", { detail: prefill }));
      setTab("bots");
    },
    [],
  );

  // Keyboard: Esc closes the coin sheet (Radix handles it); digits 1–6
  // switch tabs for power users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (target !== null || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const map: Record<string, TabId> = { "1": "radar", "2": "markets", "3": "signals", "4": "bots", "5": "backtest", "6": "saved" };
      const next = map[e.key];
      if (next) setTab(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target]);

  const liveSignalsCount = recentSignals.filter((s) => s.status !== "final").length;
  const goLongCount = snapshot?.btc
    ? recentSignals.filter((s) => s.type === "go_long" && Date.now() - new Date(s.createdAt).getTime() < 6 * 60 * 60_000).length
    : 0;

  return (
    <Shell
      tab={tab}
      onTab={setTab}
      connection={state}
      updatedAt={snapshot?.updatedAt ?? null}
      btc={snapshot?.btc ?? null}
      goLongCount={goLongCount}
      tabCounts={{
        signals: liveSignalsCount > 0 ? liveSignalsCount : undefined,
        bots: activeBots.length > 0 ? activeBots.length : undefined,
        saved: watchlist.ids.length > 0 ? watchlist.ids.length : undefined,
      }}
    >
      {tab === "radar" && <RadarView snapshot={snapshot} onOpenPair={openPair} onLaunchBot={launchBotFromPlan} />}
      {tab === "markets" && (
        <MarketsView onOpenCoin={openCoin} isStarred={watchlist.has} onToggleStar={watchlist.toggle} />
      )}
      {tab === "signals" && <SignalsView refreshKey={signalsRefreshKey} onOpenPair={openPair} />}
      {tab === "bots" && <BotsView livePrice={livePrice} onOpenPair={openPair} />}
      {tab === "backtest" && <BacktestView />}
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
