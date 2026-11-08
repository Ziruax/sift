// ── Sift V2.2 — the stateful verdict layer ───────────────────────────────────
//
// THE MISSING DECISION LAYER (external audit, Part B).
//
// V2.1's verdict was a pure function of one row snapshot: whatever the row
// looked like on this tick was the verdict on this tick. With hard-step
// thresholds everywhere (score 59.9/60.0/59.9, rvol 1.99/2.00/1.99, a BTC
// tick flipping the whole market mode, a 75-second wall-staleness cliff, a
// banded calibration jumping p by 0.12 at the 80 boundary) and a scan every
// 1-5 s over a rotating mix of fresh and stale inputs, the verdict label was
// free to flicker go ↔ watch ↔ skip on every scan — and it did.
//
// This module is the fix: a small state machine between measurement and
// display. The raw assessment stays a pure function (the measurement layer is
// good — the audit said so); the VERDICT becomes a state with:
//
//   • EWM-smoothed score       — noise never reaches the state machine raw,
//   • hysteresis               — enter GO at 60, leave it only under 53,
//   • confirmation counts      — 3 consecutive qualifying scans (5 in chop),
//   • dwell times              — a GO cannot leave before 45 s, a watch 60 s,
//   • exit confirmation        — 3 scans under the exit bar before it drops,
//   • data-age freeze          — stale inputs hold the state unchanged,
//   • hard vetoes              — stablecoin / BTC-dump / kill switch bypass
//                                dwell instantly (refusal must be immediate),
//   • display pins             — a row that leaves GO stays pinned 2 minutes
//                                so a visible coin can never be bumped out of
//                                sight by a new candidate.
//
// Every transition writes lastChangedMs + lastChangeReason, so the UI can
// show "GO since 2m 14s — confirmed 3 scans" and "exit pending — rvol 1.4 <
// 1.6" instead of silently vanishing.
//
// The reducer is pure logic with injected time, so the BACKTEST drives it
// deterministically at bar close with REPLAY_VERDICT_CONFIG — what you
// backtest is what you trade (the audit's central demand, kept).
//
// Shared by all three tiers: server scanner, browser engine, backtest.

import { V2, type BtcMode, type RowVerdict, type RowV2, type SideAssessment, type SideVerdict } from "./v2-engine";

// ── Types ────────────────────────────────────────────────────────────────────

export type VerdictStateName =
  | "inactive" // never seen / hard-vetoed / cooled down
  | "candidate" // smoothed score near the watch bar, not confirmed
  | "confirming" // smoothed score near the GO bar, awaiting confirmation
  | "go" // confirmed, dwelled, visible — the tradeable state
  | "watch" // confirmed watch (usually a demoted GO), dwelled, visible
  | "demoting"; // was go, exit not yet confirmed — still displays as GO

/** The per-pair, per-side verdict state. JSON-serializable (localStorage /
 *  snapshot transport). */
export interface VerdictState {
  name: VerdictStateName;
  /** EWM of the raw composite — the only score the state machine sees. */
  scoreSmooth: number;
  /** When this state was entered (dwell anchor). "demoting" inherits the go
   *  state's sinceMs so dwell math stays continuous. */
  sinceMs: number;
  /** Consecutive qualifying scans while confirming. */
  confirmCount: number;
  /** Consecutive scans qualifying for demotion. */
  exitCount: number;
  lastChangedMs: number;
  lastChangeReason: string | null;
  /** Display pin: a row that just left go/watch stays top-sorted until this. */
  pinnedUntilMs: number;
}

export interface VerdictConfig {
  /** The verdict tick cadence this config was built for. */
  scanCadenceMs: number;
  /** EWM alpha on the raw score. 0.25 at 3 s ≈ a 7 s half-life. */
  scoreAlpha: number;
  goEnter: number;
  goExit: number;
  watchEnter: number;
  watchExit: number;
  /** Consecutive qualifying scans to confirm a GO (chop = BTC flat mode). */
  goConfirmScans: number;
  goConfirmScansChop: number;
  /** Consecutive scans under the exit bar before a GO actually drops. */
  goExitConfirmScans: number;
  watchConfirmScans: number;
  /** A GO cannot leave (except hard veto) before this. The core flicker kill. */
  goDwellMinMs: number;
  watchDwellMinMs: number;
  /** V2.2 live fix: the lower states dwell too — a candidate holds 30 s and
   *  a confirming holds 15 s before they can fall back. Without this, a
   *  smoothed score oscillating around the watch bar flips
   *  candidate ↔ inactive on consecutive ticks (the stability chip's flip
   *  ratio caught it on the first live run). */
  candidateDwellMs: number;
  confirmingDwellMs: number;
  /** A row that leaves go/watch stays pinned in the display for this long. */
  displayPinAfterLeaveMs: number;
  /** dataAgeMs > this × scanCadenceMs → hold the previous state unchanged. */
  dataAgeFreezeMultiplier: number;
}

// ── Configs ──────────────────────────────────────────────────────────────────

// NOTE ON THE MODULE CYCLE: this module and v2-engine import each other
// (the engine's backtest drives the state machine; the state machine reads
// the engine's tunables). Both sides therefore only reference the other's
// VALUES inside function bodies — never at module top level — so either
// module load order works. The configs below are lazy getters for the same
// reason.

/** Live config — the 3 s verdict tick in both live tiers. Values are the
 *  audit's Part B.9 table; classification (ASSUMED, stability knobs) is
 *  recorded in ALGORITHM.md §17b. Lazy: reads V2 at call time. */
export function liveVerdictConfig(): VerdictConfig {
  return {
    scanCadenceMs: 3_000,
    scoreAlpha: 0.25,
    goEnter: V2.goScore, // 60 (flat mode raises the bar via goScoreFlat inside)
    goExit: V2.hysteresis.goExit, // 53
    watchEnter: V2.watchScore, // 47
    watchExit: V2.hysteresis.watchExit, // 42
    goConfirmScans: 3, // ~10 s
    goConfirmScansChop: 5, // ~15 s in BTC flat mode
    goExitConfirmScans: 3,
    watchConfirmScans: 2,
    goDwellMinMs: 45_000,
    watchDwellMinMs: 60_000,
    candidateDwellMs: 60_000, // ≥ the flip-ratio window — a candidate↔inactive round trip cannot land inside 30 s
    confirmingDwellMs: 15_000,
    displayPinAfterLeaveMs: 120_000,
    dataAgeFreezeMultiplier: 3,
  };
}

/** Replay config — the state machine driven at CLOSED 5m bars. Confirmation
 *  and dwell compress to bar-scale (3 scans ≈ 2 bars, 45 s ≈ 1 bar); the
 *  data-age freeze is disabled because a closed bar is always "fresh" at its
 *  own close. What you backtest is what you trade. Lazy: reads V2 at call
 *  time. */
export function replayVerdictConfig(): VerdictConfig {
  return {
    scanCadenceMs: 300_000, // one 5m bar
    scoreAlpha: 0.35, // slightly faster EWM — bars are already smoothed data
    goEnter: V2.goScore,
    goExit: V2.hysteresis.goExit,
    watchEnter: V2.watchScore,
    watchExit: V2.hysteresis.watchExit,
    goConfirmScans: 2,
    goConfirmScansChop: 3,
    goExitConfirmScans: 1,
    watchConfirmScans: 1,
    goDwellMinMs: 300_000, // 1 bar
    watchDwellMinMs: 300_000,
    candidateDwellMs: 0,
    confirmingDwellMs: 0,
    displayPinAfterLeaveMs: 0, // no display semantics in replay
    dataAgeFreezeMultiplier: 1e9,
  };
}

// ── The reducer ──────────────────────────────────────────────────────────────

function enter(
  prev: VerdictState | null,
  name: VerdictStateName,
  nowMs: number,
  reason: string | null,
  scoreSmooth: number,
  opts: { inheritSince?: boolean; pin?: boolean } = {},
): VerdictState {
  const wasVisible = prev !== null && (prev.name === "go" || prev.name === "watch" || prev.name === "demoting");
  return {
    name,
    scoreSmooth,
    sinceMs: opts.inheritSince && prev !== null ? prev.sinceMs : nowMs,
    confirmCount: 0,
    exitCount: 0,
    lastChangedMs: nowMs,
    lastChangeReason: reason,
    pinnedUntilMs: opts.pin === true || wasVisible ? Math.max(prev?.pinnedUntilMs ?? 0, nowMs + V2.hysteresis.displayPinAfterLeaveMs) : (prev?.pinnedUntilMs ?? 0),
  };
}

/** GO bar for a side in the current (dwelled) BTC mode. */
export function goBarFor(side: "long" | "short", btcMode: BtcMode | null): number {
  if (side === "long") return btcMode === "flat" ? V2.goScoreFlat : V2.goScore;
  return btcMode === "dump" ? V2.goScoreShortDump : V2.goScoreFlat;
}

/**
 * Advance one pair/side's verdict state by one verdict tick.
 *
 * @param prev          previous state (null = first tick for this pair)
 * @param side          which side's assessment this state tracks
 * @param assessment    the RAW (stateless) side assessment for this tick
 * @param btcMode       the DWELLED effective BTC regime (not the raw one)
 * @param nowMs         injected clock — the backtest passes bar-close time
 * @param dataAgeMs     age of the stalest input this assessment was built from
 * @param cfg           the verdict config (live or replay)
 * @param hardVeto      stablecoin / BTC-block / kill-switch — bypasses dwell
 */
export function nextVerdictState(
  prev: VerdictState | null,
  side: "long" | "short",
  assessment: SideAssessment,
  btcMode: BtcMode | null,
  nowMs: number,
  dataAgeMs: number,
  cfg: VerdictConfig,
  hardVeto = false,
): VerdictState {
  // 0. HARD VETOES bypass the data-age freeze — a BTC dump blocks longs
  //    immediately, even for pairs whose kline rotation is momentarily cold.
  //    Refusal must be immediate and total. (blocked_btc arrives as the
  //    assessment's verdict; stablecoin / kill switch arrive via hardVeto.)
  if (hardVeto || assessment.verdict === "blocked_btc") {
    if (prev === null || prev.name !== "inactive") {
      const smooth = prev ? cfg.scoreAlpha * assessment.score + (1 - cfg.scoreAlpha) * prev.scoreSmooth : assessment.score;
      return enter(prev, "inactive", nowMs, hardVeto ? "hard veto — stable/kill-switch" : "BTC regime blocks this side", smooth);
    }
    return { ...prev, scoreSmooth: prev.scoreSmooth };
  }

  // 1. DATA-AGE FREEZE — if the inputs this assessment was built from are
  //    stale, the verdict holds. A verdict must never change because a cold
  //    pair's kline pump rotation landed a block — only because the market
  //    moved on data that is actually fresh.
  if (prev && dataAgeMs > cfg.dataAgeFreezeMultiplier * cfg.scanCadenceMs) {
    return { ...prev, lastChangeReason: `stale ${Math.round(dataAgeMs / 1000)}s — verdict frozen` };
  }

  // 2. Smooth the score. The raw composite NEVER drives a transition directly.
  const scoreSmooth = prev ? cfg.scoreAlpha * assessment.score + (1 - cfg.scoreAlpha) * prev.scoreSmooth : assessment.score;

  const goBar = goBarFor(side, btcMode);
  const confirmNeed = btcMode === "flat" ? cfg.goConfirmScansChop : cfg.goConfirmScans;
  // All classic hard gates passed this scan (the expectancy meta-gate is NOT
  // a classic gate — it stays downstream of the state machine and is surfaced
  // as "would-be GO" in the UI; see the tiers' verdict overlay).
  const gatesOk = assessment.demoteGate === null || assessment.demoteGate === "expectancy";

  const st: VerdictState = prev ?? enter(null, "inactive", nowMs, null, scoreSmooth);

  switch (st.name) {
    case "inactive":
    case "candidate": {
      if (scoreSmooth >= goBar - 3) return enter(st, "confirming", nowMs, "score near the GO bar", scoreSmooth);
      if (scoreSmooth >= cfg.watchEnter) {
        if (st.name !== "candidate") return enter(st, "candidate", nowMs, "score near the watch bar", scoreSmooth);
        return { ...st, scoreSmooth, exitCount: 0 };
      }
      // Deadband: a CANDIDATE holds until the smoothed score is under the
      // watch EXIT bar (42), not merely below the enter bar (47). Without
      // this, a score oscillating around 47 flips candidate ↔ inactive on
      // consecutive ticks — the stability chip's flip ratio caught exactly
      // this on the first live run (41% before the fix).
      if (st.name === "candidate" && scoreSmooth < cfg.watchExit && nowMs - st.sinceMs >= cfg.candidateDwellMs) {
        return enter(st, "inactive", nowMs, `candidate exit — smoothed ${scoreSmooth.toFixed(0)} < ${cfg.watchExit}`, scoreSmooth);
      }
      return { ...st, scoreSmooth };
    }

    case "confirming": {
      // Deadband + dwell: confirming entered at goBar − 3, holds until
      // goBar − 6 (and for at least confirmingDwellMs) — the approach band
      // has hysteresis too, not just the GO state itself.
      if (scoreSmooth < goBar - 6 && nowMs - st.sinceMs >= cfg.confirmingDwellMs) {
        return enter(st, "candidate", nowMs, "score fell below the confirm band", scoreSmooth);
      }
      if (!gatesOk) {
        // A failing gate resets the confirmation streak — confirmation means
        // consecutive QUALIFYING scans, not consecutive ticks.
        return { ...st, scoreSmooth, confirmCount: 0, lastChangeReason: `gate ${assessment.demoteGate} failed — confirming reset` };
      }
      const confirmCount = st.confirmCount + 1;
      if (confirmCount >= confirmNeed) {
        return enter(st, "go", nowMs, `confirmed — ${confirmNeed} scans over the bar, gates green`, scoreSmooth);
      }
      return { ...st, scoreSmooth, confirmCount };
    }

    case "go": {
      // Dwell: cannot leave before goDwellMinMs unless a hard veto fired above.
      if (nowMs - st.sinceMs < cfg.goDwellMinMs) return { ...st, scoreSmooth };
      if (scoreSmooth < cfg.goExit) {
        const exitCount = st.exitCount + 1;
        if (exitCount >= cfg.goExitConfirmScans) {
          return enter(st, "watch", nowMs, `exit confirmed — smoothed score ${scoreSmooth.toFixed(0)} < ${cfg.goExit}`, scoreSmooth, { pin: true });
        }
        return { ...st, scoreSmooth, exitCount, name: "demoting", lastChangedMs: nowMs, lastChangeReason: `exit pending — smoothed ${scoreSmooth.toFixed(0)} < ${cfg.goExit} (${exitCount}/${cfg.goExitConfirmScans})` };
      }
      return { ...st, scoreSmooth, exitCount: 0 };
    }

    case "demoting": {
      // Still a GO for display purposes; the exit needs confirmation.
      if (scoreSmooth >= goBar - 3) {
        return { ...st, scoreSmooth, exitCount: 0, name: "go", lastChangedMs: nowMs, lastChangeReason: "exit reversed — score recovered" };
      }
      if (scoreSmooth < cfg.goExit) {
        const exitCount = st.exitCount + 1;
        if (exitCount >= cfg.goExitConfirmScans) {
          return enter(st, "watch", nowMs, `exit confirmed — smoothed score ${scoreSmooth.toFixed(0)} < ${cfg.goExit}`, scoreSmooth, { pin: true });
        }
        return { ...st, scoreSmooth, exitCount };
      }
      return { ...st, scoreSmooth, exitCount: 0, name: "go", lastChangedMs: nowMs, lastChangeReason: "exit reversed — score back inside the band" };
    }

    case "watch": {
      if (nowMs - st.sinceMs < cfg.watchDwellMinMs) return { ...st, scoreSmooth };
      if (scoreSmooth >= goBar - 3) return enter(st, "confirming", nowMs, "re-approaching the GO bar", scoreSmooth);
      if (scoreSmooth < cfg.watchExit) {
        return enter(st, "candidate", nowMs, `watch exit — smoothed ${scoreSmooth.toFixed(0)} < ${cfg.watchExit}`, scoreSmooth);
      }
      return { ...st, scoreSmooth };
    }
  }
}

// ── The BTC regime with dwell + ATR hysteresis ───────────────────────────────
//
// btcModeFor() is a pure step function — one BTC tick flips the whole market
// mode, which (a) moves the GO threshold by 7 points and (b) used to clear
// the cooldown ledger in one shot. That is a burst amplifier. The regime now
// needs BOTH an ATR deadband (enter bull at 0.5 × ATR, leave only under 0.3 ×)
// AND a 15 s dwell before a flip becomes effective.

export interface BtcRegimeState {
  /** The effective (dwelled) mode — what every verdict sees. */
  mode: BtcMode;
  /** When the effective mode was entered. */
  sinceMs: number;
  /** The raw (hysteresis-passed) mode awaiting dwell. */
  rawMode: BtcMode;
  rawSinceMs: number;
}

export function nextBtcRegime(
  prev: BtcRegimeState | null,
  btcChange15m: number | null | undefined,
  btcAtr15m: number | null | undefined,
  nowMs: number,
): BtcRegimeState {
  if (typeof btcChange15m !== "number" || !Number.isFinite(btcChange15m)) {
    return prev ?? { mode: "flat", sinceMs: nowMs, rawMode: "flat", rawSinceMs: nowMs };
  }
  const atr = typeof btcAtr15m === "number" && Number.isFinite(btcAtr15m) && btcAtr15m > 0 ? btcAtr15m : null;
  const enterBar = Math.max(Math.abs(V2.btcDump), atr !== null ? V2.hysteresis.btcRegimeAtrEnter * atr : Math.abs(V2.btcDump));
  const exitBar = Math.max(0.2, atr !== null ? V2.hysteresis.btcRegimeAtrExit * atr : 0.2);

  const cur = prev?.mode ?? "flat";
  // Hysteresis vs the EFFECTIVE mode: bull holds while change > exitBar,
  // dump holds while change < −exitBar, and only the opposite extreme
  // (enterBar) can flip straight across.
  let raw: BtcMode;
  if (cur === "bull") raw = btcChange15m > exitBar ? "bull" : btcChange15m < -enterBar ? "dump" : "flat";
  else if (cur === "dump") raw = btcChange15m < -exitBar ? "dump" : btcChange15m > enterBar ? "bull" : "flat";
  else raw = btcChange15m > enterBar ? "bull" : btcChange15m < -enterBar ? "dump" : "flat";

  let rawMode = prev?.rawMode ?? raw;
  let rawSinceMs = prev?.rawSinceMs ?? nowMs;
  if (raw !== rawMode) {
    rawMode = raw;
    rawSinceMs = nowMs;
  }

  let mode = prev?.mode ?? rawMode;
  let sinceMs = prev?.sinceMs ?? nowMs;
  if (rawMode !== mode && nowMs - rawSinceMs >= V2.hysteresis.btcRegimeDwellMs) {
    mode = rawMode;
    sinceMs = rawSinceMs; // effective since the raw flip, not since the dwell expired
  }
  return { mode, sinceMs, rawMode, rawSinceMs };
}

// ── Verdict-change instrumentation (the "did the fix work" log) ───────────────

export type VerdictChangeEntry = {
  pair: string;
  side: "long" | "short";
  at: number;
  from: VerdictStateName;
  to: VerdictStateName;
  scoreSmooth: number;
  rawScore: number;
  dataAgeMs: number | null;
  firstFailingGate: string | null;
  reason: string | null;
};

export type StabilityStats = {
  /** Verdict changes per pair per minute (last 10 min). Healthy: < 2. */
  changesPerPairMin: number;
  /** Share of DISPLAY-RELEVANT changes reversed within 30 s. Healthy: < 10 %.
   *  Only changes involving go/demoting/watch/confirming count — the states
   *  the user actually sees. candidate↔inactive at sub-watch scores renders
   *  "skip" on both sides (invisible bookkeeping), so it churns the count
   *  but never the perception. */
  flipRatio: number;
  /** Share of changes fired while data age > 2× cadence. Healthy: < 5 %. */
  staleFlipRatio: number;
  /** Total changes in the window. */
  windowChanges: number;
  /** Top gates blamed for changes (largest remaining flicker sources). */
  topGates: { gate: string; changes: number }[];
};

/** States whose badges the user actually sees — the flip ratio counts
 *  reversals of THESE only. */
const DISPLAY_STATES: ReadonlySet<string> = new Set(["go", "demoting", "watch", "confirming"]);

/** Stability metrics over the change log — the numbers Part B.7 asked for:
 *  what came out of the stability layer is measurable, not assumed. */
export function stabilityStats(
  log: VerdictChangeEntry[],
  nowMs: number,
  opts: { windowMs?: number; cadenceMs?: number } = {},
): StabilityStats {
  const windowMs = opts.windowMs ?? 10 * 60_000;
  const cadenceMs = opts.cadenceMs ?? 3_000; // the live verdict tick
  const recent = log.filter((e) => nowMs - e.at <= windowMs);
  if (recent.length === 0) {
    return { changesPerPairMin: 0, flipRatio: 0, staleFlipRatio: 0, windowChanges: 0, topGates: [] };
  }
  const pairs = new Set(recent.map((e) => `${e.pair}:${e.side}`)).size;
  const minutes = Math.max(1, windowMs / 60_000);
  const changesPerPairMin = recent.length / Math.max(1, pairs) / minutes;

  // Flip: a DISPLAY-RELEVANT change reversed within 30 s (A → B → A quickly,
  // where A/B are states the user can see).
  const visible = recent.filter((e) => DISPLAY_STATES.has(e.from) || DISPLAY_STATES.has(e.to));
  let flips = 0;
  for (let i = 0; i < visible.length; i += 1) {
    const e = visible[i];
    const reversal = visible.slice(i + 1).find((n) => n.pair === e.pair && n.side === e.side && n.at <= e.at + 30_000 && n.to === e.from);
    if (reversal) flips += 1;
  }
  const stale = recent.filter((e) => e.dataAgeMs !== null && e.dataAgeMs > 2 * cadenceMs).length;
  const gateCounts = new Map<string, number>();
  for (const e of recent) {
    const gate = e.firstFailingGate ?? e.reason ?? "score";
    gateCounts.set(gate, (gateCounts.get(gate) ?? 0) + 1);
  }
  const topGates = [...gateCounts.entries()]
    .map(([gate, changes]) => ({ gate, changes }))
    .sort((a, b) => b.changes - a.changes)
    .slice(0, 3);
  return {
    changesPerPairMin,
    flipRatio: visible.length > 0 ? flips / visible.length : 0,
    staleFlipRatio: stale / recent.length,
    windowChanges: recent.length,
    topGates,
  };
}

// ── Persistence (browser tier — a reload must not reset every dwell timer) ───

const STATE_STORE_KEY = "sift:vstates:v1";
const STATE_STORE_MAX_AGE_MS = 60 * 60_000; // an hour-old state map is noise, not memory

export function serializeVerdictStates(
  longs: Map<string, VerdictState>,
  shorts: Map<string, VerdictState>,
  regime: BtcRegimeState | null,
): string {
  return JSON.stringify({
    at: Date.now(),
    regime,
    longs: Object.fromEntries(longs),
    shorts: Object.fromEntries(shorts),
  });
}

export function deserializeVerdictStates(): {
  longs: Map<string, VerdictState>;
  shorts: Map<string, VerdictState>;
  regime: BtcRegimeState | null;
} | null {
  try {
    const raw = localStorage.getItem(STATE_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      at: number;
      regime: BtcRegimeState | null;
      longs: Record<string, VerdictState>;
      shorts: Record<string, VerdictState>;
    };
    if (typeof parsed.at !== "number" || Date.now() - parsed.at > STATE_STORE_MAX_AGE_MS) return null;
    const valid = (s: unknown): s is VerdictState =>
      typeof s === "object" && s !== null && typeof (s as VerdictState).name === "string" && typeof (s as VerdictState).scoreSmooth === "number";
    const longs = new Map<string, VerdictState>();
    const shorts = new Map<string, VerdictState>();
    for (const [pair, s] of Object.entries(parsed.longs ?? {})) if (valid(s)) longs.set(pair, s);
    for (const [pair, s] of Object.entries(parsed.shorts ?? {})) if (valid(s)) shorts.set(pair, s);
    return { longs, shorts, regime: parsed.regime ?? null };
  } catch {
    return null;
  }
}

export function persistVerdictStates(longs: Map<string, VerdictState>, shorts: Map<string, VerdictState>, regime: BtcRegimeState | null): void {
  try {
    localStorage.setItem(STATE_STORE_KEY, serializeVerdictStates(longs, shorts, regime));
  } catch {
    /* quota/blocked — the state rebuilds from live scans in seconds */
  }
}

/** Row-sort rank for the pinned emission order (Part B.4/B.6): GO states
 *  first, then pinned recent watches, then everything else by score. */
export function verdictSortRank(state: { name: VerdictStateName; pinnedUntilMs?: number } | null | undefined, nowMs: number): number {
  if (!state) return 2;
  if (state.name === "go" || state.name === "demoting") return 0;
  if ((state.pinnedUntilMs ?? 0) > nowMs) return 1;
  return 2;
}

// ── The verdict overlay — the state machine replaces the raw verdict ─────────
//
// The tiers call this AFTER advancing the state machines: the row's verdict
// fields become the STATE machine's output (dwell + confirmation + hysteresis),
// while the stateless assessment's verdict survives in `rawVerdict` for
// diagnostics and the shadow-mode display. The expectancy meta-gate stays
// downstream: a state-GO whose calibrated hit rate can't pay for the trade is
// an honest "would-be GO" (v2.wouldBeGo + note), never a fired one.

function expectancyNoteOf(side: SideAssessment): string | null {
  return side.warnings.find((w) => w.startsWith("Calibrated hit rate")) ?? "expectancy gate — calibrated hit rate below the GO floor";
}

function sideVerdictFromState(
  state: VerdictState,
  raw: SideAssessment,
  cfg: VerdictConfig,
  out: { verdict: SideVerdict; wouldBeGo: boolean; note: string | null },
): void {
  if (state.name === "go" || state.name === "demoting") {
    if (raw.verdict === "go") {
      out.verdict = "go";
      out.wouldBeGo = false;
      out.note = null;
    } else if (raw.demoteGate === "expectancy") {
      // The measurement layer confirmed the setup; the honesty layer refuses
      // to trade it at the calibrated odds. Surface, don't hide.
      out.verdict = "watch";
      out.wouldBeGo = true;
      out.note = expectancyNoteOf(raw);
    } else {
      // A classic gate failed through the deadband — the state machine's
      // exit confirmation is already running; display stays honest.
      out.verdict = "watch";
      out.wouldBeGo = false;
      out.note = null;
    }
  } else if (state.name === "watch") {
    out.verdict = "watch";
  } else if (state.name === "confirming" || state.name === "candidate") {
    out.verdict = state.scoreSmooth >= cfg.watchEnter ? "watch" : "skip";
  } else {
    out.verdict = "skip";
  }
}

export function overlayVerdictState(
  row: RowV2,
  long: SideAssessment,
  short: SideAssessment,
  longState: VerdictState,
  shortState: VerdictState,
  cfg: VerdictConfig,
  isStable: boolean,
): void {
  row.rawVerdict = row.verdict;
  row.state = longState;
  row.shortState = shortState;

  const longOut: { verdict: SideVerdict; wouldBeGo: boolean; note: string | null } = { verdict: "skip", wouldBeGo: false, note: null };
  const shortOut: { verdict: SideVerdict; wouldBeGo: boolean; note: string | null } = { verdict: "skip", wouldBeGo: false, note: null };
  sideVerdictFromState(longState, long, cfg, longOut);
  sideVerdictFromState(shortState, short, cfg, shortOut);

  row.longVerdict = longOut.verdict;
  row.shortVerdict = shortOut.verdict;
  row.wouldBeGo = longOut.wouldBeGo || shortOut.wouldBeGo;
  row.expectancyNote = longOut.wouldBeGo ? longOut.note : shortOut.wouldBeGo ? shortOut.note : null;

  // Row-level verdict, same priority ladder as the raw assessment.
  let verdict: RowVerdict;
  if (isStable) verdict = "stable";
  else if (row.longVerdict === "go") verdict = "go_long";
  else if (row.shortVerdict === "go") verdict = "go_short";
  else if (long.verdict === "blocked_btc") verdict = "blocked_btc";
  else if (row.longVerdict === "watch" || row.shortVerdict === "watch") verdict = "watch";
  else verdict = "skip";
  row.verdict = verdict;
}
