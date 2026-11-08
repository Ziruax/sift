"use client";

// ── Local radar engine — the scanner that lives in the browser ───────────────
//
// The sandbox runs a server-side scanner (mini-service) that watches the
// market 24/7. Deployed static hosting has no such luxury — so this module
// recreates the same radar using Binance's PUBLIC websocket market streams,
// no key, no server, straight from the user's browser:
//
//   WS A  !miniTicker@arr      every USDT pair's 24h stats, pushed ~1/sec
//   WS B  aggTrade streams     the universe's trades, tick by tick
//   REST  klines               bootstrap 24h of 1m candles per pair (once)
//   REST  depth?limit=100      walls/spread/depth-at-TP2, paced per tick
//   REST  fapi.binance.com     funding / OI / long-short, best-effort
//
// It feeds the SHARED V2.1 engine (v2-engine.ts) through the same
// rowInputFromRadar adapter the server scanner uses, with the SHARED pure
// math from baseline.ts — one brain, two tiers, zero drift. The V2.1 audit
// wiring that matters here:
//
//   • universe ranked by volume ANOMALY vs a persisted 7-day history (§2.2)
//   • 24h, time-of-day-adjusted, self-excluded volume baseline (§2.3)
//   • session high anchored to the rolling 24h ticker high (§2.6)
//   • beta / residual momentum vs BTC, CVD slope, trade-size skew (§3.4/§4)
//   • 100-level book analysis: walls, spread, depth-to-TP2, wall AGE (§2.5)
//   • best-effort futures positioning from fapi (CORS-open, null on fail) (§9)
//   • portfolio guard + kill switch (§5.2), regime-reset cooldowns (§13),
//     backtest calibration (§8) and a LIVE shadow log of every gate veto (§6)
//     — persisted and graded at 60m, so the filters stay accountable.
//
// Signals are kept in localStorage and mirrored to the server log
// best-effort, so the Signals tab works even with no backend at all.
//
// Two small honest differences from the server scanner:
//   • prices are tick-level (faster than the 5s REST cadence), and
//   • futures positioning only exists for pairs fapi knows (spot-only coins
//     assess with nulls — the engine treats null as "no data", not "fine").

import type { BtcContext, MarketSignal, PairUpdate, RadarRow, RadarSnapshot, SignalType } from "./types";
import {
  CooldownLedger,
  PortfolioGuard,
  V2,
  assessRowWithSides,
  atrPctFromCandles,
  atrWindow,
  rowInputFromRadar,
  stablecoinLike,
  type Calibration,
  type V2Wall,
} from "./v2-engine";
import {
  deserializeVerdictStates,
  liveVerdictConfig,
  nextBtcRegime,
  nextVerdictState,
  overlayVerdictState,
  persistVerdictStates,
  stabilityStats,
  verdictSortRank,
  type BtcRegimeState,
  type VerdictChangeEntry,
  type VerdictConfig,
  type VerdictState,
} from "./verdict-state";
import {
  analyzeDepth,
  anomalyScore,
  betaFromCloses,
  cvdSlope,
  fiveMinuteBlocks,
  isJunkBase,
  listingAgeDays,
  median,
  rankForSignalCut,
  sizeSpike,
  trackWallAge,
  volumeBaseline,
  type WallTrack,
} from "./baseline";

// ── Configuration ─────────────────────────────────────────────────────────────

const WS_HOSTS = ["wss://data-stream.binance.vision", "wss://stream.binance.com:9443"];
const REST_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
// §9 — futures REST lives on its own CORS-open host; no failover, best-effort.
const FAPI_HOST = "https://fapi.binance.com";
const UNIVERSE_LIMIT = 60;
const UNIVERSE_POOL = 100; // candidates that earn the batched trade-count fetch
const UNIVERSE_MIN_QUOTE_VOL = 2_000_000; // §2.2 hard liquidity floor
const UNIVERSE_MIN_TRADE_COUNT = 5_000; // §2.2 thin-tape floor
const UNIVERSE_REFRESH_MS = 5 * 60_000;
const COMPUTE_INTERVAL_MS = 1_000; // price/display cadence — the verdict tick runs every 3rd compute (3 s)
const VERDICT_EVERY_N_COMPUTES = 3; // V2.2 — audit Part B.5: decouple display from verdict cadence
const VERDICT_STATE_SAVE_MS = 30_000; // V2.2 — persist dwell/pin timers across reloads
const KLINE_LIMIT = 288; // §2.3 — 24h of 1m candles, same request-weight class
const SIGNAL_COOLDOWN_MS = 10 * 60_000;
const MAX_SIGNALS_PER_SCAN = 6;
const OUTCOME_HORIZON_MS = 60 * 60_000;
const WALL_TTL_MS = 20_000;
const WALL_KNOWN_MS = 70_000;
const WALL_CANDIDATE_LIMIT = 12;
const STALE_AFTER_MS = 15_000;
const LOCAL_SIGNALS_KEY = "sift:localsignals:v1";
const LOCAL_SIGNALS_MAX = 400;
const INGEST_KEY = "sift-local-dev-key";
const CALIBRATION_KEY = "sift:calibration:v1"; // §8 — written by the Backtest UI
const FUT_CACHE_MS = 60_000; // §9 — one positioning refresh per pair per minute

// §2.1 — the old STABLE/FIAT/PEGGED sets + suffix heuristics + isBStock died
// (they silently killed JUP, BNB, SHIB, ARB…). isJunkBase (baseline.ts) is
// the exact-match blacklist everywhere. This SMALL exact set survives only
// for the runtime isStablecoin probe below: stable/pegged bases first, then
// the full blacklist (fiat + leveraged tapes move like pegs), then the
// behavioral peg check on price/change.
const STABLE_OR_PEGGED = new Set([
  "USDT", "USDC", "FDUSD", "DAI", "TUSD", "USDP", "BUSD", "BFUSD", "USDS",
  "RLUSD", "USD1", "USDE", "USD0", "PYUSD", "EURC", "USDD", "FRAX", "LUSD",
  "GUSD", "XUSD", "RWUSD", "XAUT", "PAXG",
]);

function isStableAsset(base: string, price: number, change15m: number, change24h: number): boolean {
  return STABLE_OR_PEGGED.has(base) || isJunkBase(base) || stablecoinLike(price, change15m, change24h);
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ── Scoring (identical to the server scanner) ─────────────────────────────────

function pumpScore(
  rvol: number,
  tradeSpike: number,
  change1m: number,
  change5m: number,
  change15m: number,
  buyPct: number,
  closeStrength: number,
): number {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const rvolPts = 30 * clamp01((rvol - 1) / 4);
  const tradePts = 10 * clamp01((tradeSpike - 1) / 4);
  let momentumPts = 0;
  if (change1m > 0 && change5m > 0 && change15m > 0) momentumPts += 10;
  if (change5m > 0 && change5m >= change15m) momentumPts += 8;
  if (change1m > 0 && change1m >= change5m) momentumPts += 7;
  const buyPts = 20 * clamp01((buyPct - 50) / 30);
  const closePts = 15 * clamp01(closeStrength);
  // §10 — UNCAPPED: ranking and GO-priority ordering want the raw composite;
  // the UI caps display at 100 elsewhere (with a "+" marker).
  return Math.round(Math.max(0, rvolPts + tradePts + momentumPts + buyPts + closePts));
}

function badgeFor(score: number, rvol: number, change24h: number, belowHighPct: number): RadarRow["badge"] {
  if (change24h > 8) return "pumped";
  if (score >= 80) return "pump";
  if (belowHighPct >= 3) return "dumping";
  if (rvol >= 3 && change24h >= -5 && change24h <= 8) return "early";
  return null;
}

function decideSignal(row: RadarRow): RadarRow["signal"] {
  if (row.change24h <= 8 && row.score >= 80 && row.change5m > 0) return "pumping";
  if (row.badge === "dumping" && row.rvol >= 2 && row.change5m < 0) return "dumping";
  const flatDay = row.change24h >= -5 && row.change24h <= 8;
  const flatNow = Math.abs(row.change1m) <= 1 && Math.abs(row.change5m) <= 1;
  if (flatDay && flatNow && row.rvol >= 2 && row.buyPct >= 70) return "long";
  if (flatDay && flatNow && row.rvol >= 2 && row.buyPct <= 30) return "short";
  return "flat";
}

const DIRECTION: Record<SignalType, "long" | "short"> = {
  pump_start: "long",
  volume_lead: "long",
  buyer_pressure: "long",
  seller_pressure: "short",
  dump_start: "short",
  spike_collapse: "short",
  go_long: "long",
  go_short: "short",
};

const BEARISH_TYPES: SignalType[] = ["seller_pressure", "dump_start", "spike_collapse"];

function signalNote(type: SignalType, row: RadarRow): string {
  switch (type) {
    case "pump_start":
      return `Score ${row.score}: ${row.rvol.toFixed(1)}× volume, takers ${row.buyPct.toFixed(0)}% buys, price ${row.change5m >= 0 ? "+" : ""}${row.change5m.toFixed(2)}% in 5m.`;
    case "volume_lead":
      return `${row.rvol.toFixed(1)}× volume while price held flat (±1%) — the money arrived before the move.`;
    case "buyer_pressure":
      return `Flat coin, takers buying ${row.buyPct.toFixed(0)}% of a ${row.rvol.toFixed(1)}× volume tape.`;
    case "seller_pressure":
      return `Flat coin, takers selling ${(100 - row.buyPct).toFixed(0)}% of a ${row.rvol.toFixed(1)}× volume tape.`;
    case "dump_start":
      return `${row.belowHighPct.toFixed(1)}% below the session high with ${row.rvol.toFixed(1)}× volume and a falling 5m tape.`;
    case "spike_collapse":
      return `Volume spike collapsed to ${row.rvol.toFixed(1)}× — the crowd that pushed the move is leaving.`;
    case "go_long": {
      const v = row.v2;
      const t = v?.trade;
      const parts: string[] = [`V2 score ${v?.longScore ?? row.score} — all seven filters passed`];
      if (t) parts.push(`stop −${t.riskPct.toFixed(1)}%, TP1 +${t.tp1Pct.toFixed(1)}%, TP2 +${t.tp2Pct.toFixed(1)}%`);
      if (v?.wall) parts.push(`cleared the $${Math.round(v.wall.valueUsd / 1000)}K wall`);
      return `${parts.join(" · ")}.`;
    }
    case "go_short": {
      const v = row.v2;
      const t = v?.shortTrade;
      const parts: string[] = [`V2 short score ${v?.shortScore ?? row.score} — dump confirmed by the filters`];
      if (t) parts.push(`stop +${t.riskPct.toFixed(1)}%, TP1 −${t.tp1Pct.toFixed(1)}%, TP2 −${t.tp2Pct.toFixed(1)}%`);
      if (v?.wall) parts.push(`trapped under the $${Math.round(v.wall.valueUsd / 1000)}K wall`);
      return `${parts.join(" · ")}.`;
    }
  }
}

// ── Local signal log (localStorage + subscribers) ─────────────────────────────

let localSignalsCache: MarketSignal[] | null = null;
const localSignalListeners = new Set<() => void>();

function readLocalSignals(): MarketSignal[] {
  if (localSignalsCache === null) {
    try {
      const raw = localStorage.getItem(LOCAL_SIGNALS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      localSignalsCache = Array.isArray(parsed) ? (parsed as MarketSignal[]).filter((s) => s && typeof s.id === "string") : [];
    } catch {
      localSignalsCache = [];
    }
  }
  return localSignalsCache;
}

function writeLocalSignals(next: MarketSignal[]) {
  localSignalsCache = next.slice(0, LOCAL_SIGNALS_MAX);
  try {
    localStorage.setItem(LOCAL_SIGNALS_KEY, JSON.stringify(localSignalsCache));
  } catch {
    /* storage full — in-memory log still works */
  }
  for (const listener of localSignalListeners) listener();
}

export function subscribeLocalSignals(listener: () => void): () => void {
  localSignalListeners.add(listener);
  return () => {
    localSignalListeners.delete(listener);
  };
}

export function getLocalSignals(): MarketSignal[] {
  return readLocalSignals();
}

export function clearLocalSignals(): void {
  writeLocalSignals([]);
}

// ── Live shadow log (§6) — would-be GOs the gates vetoed, graded anyway ──────
//
// Every row the engine demotes from GO to watch via a hard gate (and every
// portfolio-guard veto) lands here with its entry price; 60 minutes later the
// direction-adjusted change fills in. The gate list then tells you WHICH veto
// is actually costing money — the live twin of the backtest shadow log.

export type ShadowLogEntry = { pair: string; side: "long" | "short"; gate: string; at: string; price: number; change60m: number | null };

const SHADOW_LOG_KEY = "sift:shadowlog:v1";
const SHADOW_LOG_MAX = 400;
const SHADOW_DEDUPE_MS = 30 * 60_000; // one entry per pair:side:gate per 30 min

let shadowLogCache: ShadowLogEntry[] | null = null;
const shadowLastLogged = new Map<string, number>(); // `${pair}:${side}:${gate}` → ms

function readShadowLog(): ShadowLogEntry[] {
  if (shadowLogCache === null) {
    try {
      const raw = localStorage.getItem(SHADOW_LOG_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      shadowLogCache = Array.isArray(parsed)
        ? (parsed as ShadowLogEntry[]).filter((e) => e && typeof e.pair === "string" && typeof e.side === "string" && typeof e.gate === "string")
        : [];
    } catch {
      shadowLogCache = [];
    }
    // Seed the dedupe map from the persisted log (newest-first) so a page
    // reload cannot re-log the same gate inside its own cooldown.
    for (const e of shadowLogCache) {
      const key = `${e.pair}:${e.side}:${e.gate}`;
      const at = Date.parse(e.at);
      if (Number.isFinite(at) && (shadowLastLogged.get(key) ?? 0) < at) shadowLastLogged.set(key, at);
    }
  }
  return shadowLogCache;
}

function writeShadowLog(entries: ShadowLogEntry[]): void {
  shadowLogCache = entries.slice(0, SHADOW_LOG_MAX); // newest first, bounded
  try {
    localStorage.setItem(SHADOW_LOG_KEY, JSON.stringify(shadowLogCache));
  } catch {
    /* storage full — in-memory log still works */
  }
}

export function getLocalShadowSignals(): ShadowLogEntry[] {
  return readShadowLog();
}

// ── 24h-volume history for anomaly universe ranking (§2.2) ───────────────────
//
// Persisted per pair in localStorage ({ [pair]: number[] }): one 24h
// quote-volume snapshot per 3h bucket, max 56 samples (7 days), map capped to
// ~400 highest-volume pairs. anomalyScore(current, history) then ranks the
// universe by "money arriving HERE, now" instead of absolute size — a big
// coin idling at its own baseline stops crowding out a small coin erupting.

const VOLHIST_KEY = "sift:volhist:v1";
const VOLHIST_BUCKET_MS = 3 * 60 * 60_000;
const VOLHIST_MAX_SAMPLES = 56; // 7 days of 3h buckets
const VOLHIST_MAX_PAIRS = 400;

let volHistCache: Map<string, number[]> | null = null;
const volBucketSeen = new Map<string, number>(); // pair → last-appended 3h bucket

function readVolHistory(): Map<string, number[]> {
  if (volHistCache === null) {
    try {
      const raw = localStorage.getItem(VOLHIST_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      const map = new Map<string, number[]>();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [pair, samples] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(samples)) {
            map.set(pair, samples.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0));
          }
        }
      }
      volHistCache = map;
    } catch {
      volHistCache = new Map();
    }
  }
  return volHistCache;
}

function writeVolHistory(map: Map<string, number[]>): void {
  volHistCache = map;
  try {
    const obj: Record<string, number[]> = {};
    for (const [pair, samples] of map) obj[pair] = samples;
    localStorage.setItem(VOLHIST_KEY, JSON.stringify(obj));
  } catch {
    /* storage full — anomaly ranking degrades to absolute after reload */
  }
}

/** Append one snapshot per pair per 3h bucket and keep the map capped. The
 *  bucket dedupe is in-memory: a reload inside the same bucket may append one
 *  duplicate sample — the median the anomaly uses tolerates that. */
function appendVolHistory(appends: Array<{ pair: string; quoteVol: number }>, currentVol: Map<string, number>): void {
  const map = readVolHistory();
  const bucket = Math.floor(Date.now() / VOLHIST_BUCKET_MS);
  let changed = false;
  for (const { pair, quoteVol } of appends) {
    if (volBucketSeen.get(pair) === bucket) continue;
    volBucketSeen.set(pair, bucket);
    const samples = map.get(pair) ?? [];
    samples.push(quoteVol);
    map.set(pair, samples.slice(-VOLHIST_MAX_SAMPLES));
    changed = true;
  }
  if (map.size > VOLHIST_MAX_PAIRS) {
    // Keep the highest-volume pairs — current quoteVol where the live tape
    // knows it, else the freshest stored sample (delisted pairs age out last).
    const ranked = [...map.entries()].sort(
      (a, b) =>
        Math.max(currentVol.get(b[0]) ?? 0, b[1][b[1].length - 1] ?? 0) -
        Math.max(currentVol.get(a[0]) ?? 0, a[1][a[1].length - 1] ?? 0),
    );
    for (const [pair] of ranked.slice(VOLHIST_MAX_PAIRS)) map.delete(pair);
    changed = true;
  }
  if (changed) writeVolHistory(map);
}

// ── Ingest mirror (best-effort; works in the sandbox, no-ops elsewhere) ───────

async function postIngest(body: unknown): Promise<boolean> {
  try {
    const response = await fetch("/api/signals/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sift-ingest-key": INGEST_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ── The engine ────────────────────────────────────────────────────────────────

type MinuteBucket = {
  qv: number; // quote volume traded that minute
  tr: number; // trade count
  tb: number; // taker-buy quote volume
  o: number;
  h: number;
  l: number;
  c: number;
};

type TickerRow = {
  price: number;
  changePct: number;
  quoteVol: number;
  high: number; // §2.6 — the TRUE rolling 24h high from miniTicker `h`
  low: number;
};

// §5.2 — riskPct rides along undeclared on MarketSignal (types.ts is frozen);
// the kill switch needs it to grade the 60m outcome in units of risk (R).
type TrackedSignal = MarketSignal & { lastPriceAt: number; riskPct?: number | null };

// §2.5/§3.2/§4 — the extended wall snapshot analyzeDepth produces.
type WallEntry = {
  at: number;
  ask: V2Wall;
  bid: V2Wall;
  spreadBps: number | null;
  askDepthUsd: number; // asks up to +7% — the TP2 runway
  askWallToDepth: number | null;
  bidWallToDepth: number | null;
};

// §9 — cached futures positioning per pair (nulls = fapi failed / no perp).
type FuturesSnapshot = { at: number; funding: number | null; oi: number | null; ls: number | null };

// §6 — shadow entries still waiting for their 60m grade.
type PendingShadow = { pair: string; side: "long" | "short"; gate: string; atMs: number; price: number };

type EngineListeners = {
  onSnapshot?: (snapshot: RadarSnapshot) => void;
  onSignal?: (signal: MarketSignal) => void;
  onPairUpdate?: (update: PairUpdate) => void;
};

class LocalRadarEngine {
  private listeners: EngineListeners = {};
  private wsA: WebSocket | null = null;
  private wsB: WebSocket | null = null;
  private hostIdx = 0;
  private computeTimer: ReturnType<typeof setInterval> | null = null;
  private universeTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;

  private tickers = new Map<string, TickerRow>();
  private buckets = new Map<string, Map<number, MinuteBucket>>();
  private lastPrices = new Map<string, number>();
  private sessionHighs = new Map<string, number>();
  private prevRvol = new Map<string, number>();
  private universe: string[] = [];
  private universeBuiltSmall = false; // set when the universe was ranked from a partial ticker batch
  private universeRefreshing = false; // refreshUniverse is async now — one at a time
  private extraPairs = new Set<string>();
  private missingPairs = new Set<string>();
  private bootstrapped = new Set<string>();
  private bootstrapping = new Set<string>();

  private lastMessageAt = 0;
  private scans = 0;
  private running = false;

  private tracked: TrackedSignal[] = [];
  private cooldowns = new Map<string, number>();
  private ledger = new CooldownLedger();
  private guard = new PortfolioGuard(); // §5.2 — concurrency / correlation / kill switch
  private calibration: Calibration | null = null; // §8 — from the Backtest UI
  private lastBtcMode: string | null = null; // §13 — regime-flip detector
  // ── V2.2 — the stateful verdict layer (audit Part B) ──────────────────────
  private verdictLongStates = new Map<string, VerdictState>();
  private verdictShortStates = new Map<string, VerdictState>();
  private btcRegime: BtcRegimeState | null = null;
  private verdictChangeLog: VerdictChangeEntry[] = []; // newest first, bounded
  private lastTapeMs = new Map<string, number>(); // aggTrade/bucket freshness per pair
  private askAbsentSince = new Map<string, number>(); // wall-absence confirmation
  private bidAbsentSince = new Map<string, number>();
  private computeTick = 0;
  private stateSaveAt = 0;
  private liveCfg: VerdictConfig = liveVerdictConfig();
  private dirtyOutcomes: MarketSignal[] = [];
  private walls = new Map<string, WallEntry>();
  private wallTracks = new Map<string, WallTrack>(); // §4 — wall persistence
  private wallBreaks = new Map<string, { wallPrice: number; aboveSince: number | null }>();
  private futures = new Map<string, FuturesSnapshot>(); // §9
  private futuresQueue: string[] = [];
  private fapiInFlight = false;
  private historyBlocksByPair = new Map<string, number>(); // §2.3 → V2Input.historyBlocks
  private firstCandleMs = new Map<string, number>(); // §4 — 0 = age unknowable from a full 24h window
  private shadowPending: PendingShadow[] = [];
  private lastSnapshot: RadarSnapshot | null = null;
  private btcContext: BtcContext | null = null;
  private wallQueue: string[] = [];
  private wallInFlight = false;

  setListeners(listeners: EngineListeners) {
    this.listeners = { ...this.listeners, ...listeners };
  }

  getRow(pair: string): RadarRow | null {
    return this.lastSnapshot?.rows.find((r) => r.pair === pair.toUpperCase()) ?? null;
  }

  isRunning(): boolean {
    return this.running;
  }

  isStale(): boolean {
    return Date.now() - this.lastMessageAt > STALE_AFTER_MS;
  }

  /** Diagnostics for the console hook — read-only view of the engine. */
  debugState(): Record<string, unknown> {
    return {
      running: this.running,
      wsAState: this.wsA ? this.wsA.readyState : null, // 0 connecting, 1 open, 2 closing, 3 closed
      wsBState: this.wsB ? this.wsB.readyState : null,
      hostIdx: this.hostIdx,
      tickers: this.tickers.size,
      universe: this.universe.length,
      buckets: this.buckets.size,
      bootstrapped: this.bootstrapped.size,
      missing: this.missingPairs.size,
      lastMessageAgeSec: this.lastMessageAt > 0 ? Math.round((Date.now() - this.lastMessageAt) / 1000) : null,
      scans: this.scans,
      backoffMs: this.backoffMs,
      extraPairs: [...this.extraPairs],
      universeSample: this.universe.slice(0, 8),
      shadow: readShadowLog().length,
      calibration: this.calibration ? this.calibration.bins.length : null,
      guardKilled: this.guard.killed(),
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    if (this.running || typeof window === "undefined") return;
    this.running = true;
    this.loadCalibration(); // §8 — calibrated from the very first scan
    // V2.2 — restore the verdict states so a reload never resets every dwell
    // timer (a GO that was 40 s into its dwell stays a GO, not a newborn).
    const restored = deserializeVerdictStates();
    if (restored) {
      this.verdictLongStates = restored.longs;
      this.verdictShortStates = restored.shorts;
      this.btcRegime = restored.regime;
    }
    // Reload the tracked signals from the local log (they keep grading across
    // page reloads — same accountability the server scanner has).
    this.tracked = readLocalSignals()
      .filter((s) => s.status !== "final" || Date.now() - new Date(s.createdAt).getTime() < OUTCOME_HORIZON_MS)
      .map((s) => ({
        ...s,
        lastPriceAt: Date.now(),
        riskPct: (s as MarketSignal & { riskPct?: number | null }).riskPct ?? null,
      }));
    this.openWebSocketA();
    this.computeTimer = setInterval(() => this.compute(), COMPUTE_INTERVAL_MS);
    this.universeTimer = setInterval(() => void this.refreshUniverse(), UNIVERSE_REFRESH_MS);
  }

  stop() {
    this.running = false;
    if (this.computeTimer) clearInterval(this.computeTimer);
    if (this.universeTimer) clearInterval(this.universeTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.computeTimer = null;
    this.universeTimer = null;
    this.reconnectTimer = null;
    try {
      this.wsA?.close();
      this.wsB?.close();
    } catch {
      /* already closed */
    }
    this.wsA = null;
    this.wsB = null;
  }

  // ── WebSocket A: all-market 24h mini tickers ─────────────────────────────
  // !miniTicker@arr, not !ticker@arr: the full-ticker array stream
  // delivers nothing on several of Binance's mirror hosts (observed live:
  // handshake completes, zero frames), while the mini-ticker array streams
  // reliably and is lighter anyway. Price-change % is derived from
  // (close − open) / open — the same number Binance reports.

  private openWebSocketA() {
    if (!this.running) return;
    const host = WS_HOSTS[this.hostIdx % WS_HOSTS.length];
    try {
      const ws = new WebSocket(`${host}/ws/!miniTicker@arr`);
      this.wsA = ws;
      ws.onmessage = (event) => {
        this.lastMessageAt = Date.now();
        this.backoffMs = 1_000;
        try {
          const payload = JSON.parse(event.data as string) as Array<Record<string, unknown>>;
          if (!Array.isArray(payload)) return;
          for (const t of payload) {
            const symbol = typeof t.s === "string" ? t.s.toUpperCase() : "";
            if (!symbol.endsWith("USDT")) continue;
            const price = num(t.c);
            if (price <= 0) continue;
            const open = num(t.o);
            this.tickers.set(symbol, {
              price,
              changePct: open > 0 ? ((price - open) / open) * 100 : 0,
              quoteVol: num(t.q),
              high: num(t.h),
              low: num(t.l),
            });
            const prev = this.lastPrices.get(symbol) ?? 0;
            if (price !== prev) this.lastPrices.set(symbol, price);
            const high = this.sessionHighs.get(symbol) ?? 0;
            if (price > high) this.sessionHighs.set(symbol, price);
          }
          if (this.universe.length === 0) {
            this.universeBuiltSmall = payload.length < 100;
            void this.refreshUniverse();
          } else if (this.universeBuiltSmall && this.tickers.size >= 150) {
            // The first batch only knew a fraction of the tape — re-rank now
            // that (nearly) all USDT pairs have reported in.
            this.universeBuiltSmall = false;
            void this.refreshUniverse();
          }
        } catch {
          /* malformed frame — skip */
        }
      };
      ws.onclose = () => {
        if (!this.running) return;
        this.scheduleReconnect(() => this.openWebSocketA());
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    } catch {
      this.scheduleReconnect(() => this.openWebSocketA());
    }
  }

  private scheduleReconnect(reopen: () => void) {
    if (!this.running || this.reconnectTimer !== null) return;
    this.hostIdx += 1; // rotate hosts on failure
    const wait = this.backoffMs;
    this.backoffMs = Math.min(30_000, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      reopen();
    }, wait);
  }

  // ── WebSocket B: aggTrade streams for the universe + extras ────────────────

  private openWebSocketB(streams: string[]) {
    if (!this.running || streams.length === 0) return;
    const host = WS_HOSTS[this.hostIdx % WS_HOSTS.length];
    const url = `${host}/stream?streams=${streams.join("/")}`;
    try {
      const ws = new WebSocket(url);
      this.wsB = ws;
      ws.onmessage = (event) => {
        this.lastMessageAt = Date.now();
        try {
          const envelope = JSON.parse(event.data as string) as { stream?: unknown; data?: Record<string, unknown> };
          const trade = envelope.data ?? (envelope as Record<string, unknown>);
          if (typeof trade.s !== "string") return;
          this.applyAggTrade(trade.s.toUpperCase(), num(trade.p), num(trade.q), trade.m === true);
        } catch {
          /* malformed frame — skip */
        }
      };
      ws.onclose = () => {
        if (!this.running) return;
        // Re-open with whatever the current universe is.
        this.wsB = null;
        this.scheduleReconnect(() => this.openWebSocketB(this.streamList()));
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    } catch {
      this.scheduleReconnect(() => this.openWebSocketB(this.streamList()));
    }
  }

  private streamList(): string[] {
    const pairs = [...new Set([...this.universe, ...this.extraPairs])].filter((p) => !this.missingPairs.has(p));
    return pairs.map((p) => `${p.toLowerCase()}@aggTrade`);
  }

  private applyAggTrade(pair: string, price: number, qty: number, buyerIsMaker: boolean) {
    if (price <= 0 || qty < 0) return;
    // V2.2 — the per-pair tape freshness clock: the verdict's data-age freeze
    // reads exactly this (buckets ARE the verdict inputs).
    this.lastTapeMs.set(pair, Date.now());
    let buckets = this.buckets.get(pair);
    if (!buckets) {
      buckets = new Map();
      this.buckets.set(pair, buckets);
    }
    const minute = Math.floor(Date.now() / 60_000);
    let bucket = buckets.get(minute);
    if (!bucket) {
      bucket = { qv: 0, tr: 0, tb: 0, o: price, h: price, l: price, c: price };
      buckets.set(minute, bucket);
    }
    const quote = price * qty;
    bucket.qv += quote;
    bucket.tr += 1;
    if (!buyerIsMaker) bucket.tb += quote; // aggressor was a buyer
    if (price > bucket.h) bucket.h = price;
    if (price < bucket.l) bucket.l = price;
    bucket.c = price;
    this.lastPrices.set(pair, price);
    const high = this.sessionHighs.get(pair) ?? 0;
    if (price > high) this.sessionHighs.set(pair, price);
    // Prune old minutes occasionally (cheap: only when the map overflows).
    // §2.3 — ~1450 minutes ≈ the 24h the baseline and §2.6 session high need.
    if (buckets.size > 1450) {
      const cutoff = minute - 1440;
      for (const key of buckets.keys()) {
        if (key < cutoff) buckets.delete(key);
      }
    }
  }

  // ── REST bootstrap + failover fetch ────────────────────────────────────────

  private async restFetch(path: string, timeoutMs = 10_000): Promise<unknown> {
    let lastError: unknown = null;
    for (let i = 0; i < REST_HOSTS.length; i += 1) {
      const host = REST_HOSTS[(this.hostIdx + i) % REST_HOSTS.length];
      try {
        const response = await fetch(host + path, {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`Binance responded ${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : "";
        if (/responded 4(00|04)/.test(message)) throw error; // pair genuinely missing
      }
    }
    throw lastError ?? new Error("Binance unreachable");
  }

  // §9 — the futures host gets its own fetch: no mirror rotation, and every
  // failure is the caller's "cache nulls" path, never an error surfacing.
  private async fapiFetch(path: string, timeoutMs = 8_000): Promise<unknown> {
    const response = await fetch(FAPI_HOST + path, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`fapi responded ${response.status}`);
    return await response.json();
  }

  private async bootstrapPair(pair: string) {
    if (this.bootstrapped.has(pair) || this.bootstrapping.has(pair)) return;
    this.bootstrapping.add(pair);
    try {
      // §2.3 — 288 × 1m = 24h of candles: enough blocks for the time-of-day
      // baseline, same request-weight class as the old 61-bar peek.
      const payload = await this.restFetch(`/api/v3/klines?symbol=${pair}&interval=1m&limit=${KLINE_LIMIT}`);
      if (!Array.isArray(payload)) return;
      const buckets = new Map<number, MinuteBucket>();
      for (const k of payload as unknown[][]) {
        const minute = Math.floor(num(k[0]) / 60_000);
        buckets.set(minute, {
          qv: num(k[7]),
          tr: num(k[8]),
          tb: num(k[10]),
          o: num(k[1]),
          h: num(k[2]),
          l: num(k[3]),
          c: num(k[4]),
        });
        const high = this.sessionHighs.get(pair) ?? 0;
        if (num(k[2]) > high) this.sessionHighs.set(pair, num(k[2]));
      }
      if (buckets.size >= 16) {
        this.buckets.set(pair, buckets);
        this.bootstrapped.add(pair);
        this.missingPairs.delete(pair);
        // §4 — listing age, honestly bounded: when Binance returns FEWER than
        // a full 24h of candles the oldest one IS the first candle ever. A
        // full window only proves "≥ 24h old" — the exact age is unknowable
        // without another call, so it stays 0 → listingAgeDays null → the
        // engine's listing gate passes rather than lying with a fake age.
        const candles = payload as unknown[][];
        this.firstCandleMs.set(pair, candles.length < KLINE_LIMIT ? num(candles[0]?.[0]) : 0);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/responded 4(00|04)/.test(message)) {
        this.missingPairs.add(pair);
        // Tell the coin sheet honestly: no such pair on Binance spot.
        this.listeners.onPairUpdate?.({
          pair,
          base: pair.replace(/USDT$/, ""),
          price: 0,
          change1m: 0,
          change5m: 0,
          change15m: 0,
          change24h: 0,
          volume24h: 0,
          vol5mUsd: 0,
          volAvg5mUsd: 0,
          rvol: 0,
          trades5m: 0,
          buyPct: 50,
          score: 0,
          sessionHigh: 0,
          belowHighPct: 0,
          volumeLead: false,
          spikeFalling: false,
          askWall: null,
          bidWall: null,
          v2: null,
          spark: [],
          exists: false,
        });
      }
    } finally {
      this.bootstrapping.delete(pair);
    }
  }

  // ── Universe (§2.2 — ranked by volume ANOMALY, not absolute volume) ──────

  private async refreshUniverse(): Promise<void> {
    this.loadCalibration(); // §8 — the Backtest UI writes the key out-of-band
    if (this.universeRefreshing) return; // async now — one refresh at a time
    this.universeRefreshing = true;
    try {
      // §2.1 — the FIXED exact-match blacklist (no more suffix heuristics that
      // silently killed JUP/BNB/SHIB/ARB). §2.2 — hard dollar-volume floor.
      const ranked: Array<{ pair: string; quoteVol: number; anomaly: number; hasHistory: boolean }> = [];
      for (const [pair, ticker] of this.tickers) {
        const base = pair.slice(0, -4);
        if (!base || isJunkBase(base)) continue;
        if (ticker.quoteVol < UNIVERSE_MIN_QUOTE_VOL) continue;
        // Anomaly vs the history BEFORE this refresh's snapshot is appended —
        // the current value must not dilute its own baseline.
        const history = readVolHistory().get(pair) ?? [];
        ranked.push({
          pair,
          quoteVol: ticker.quoteVol,
          anomaly: anomalyScore(ticker.quoteVol, history),
          hasHistory: history.filter((v) => v > 0).length >= 2,
        });
      }
      const currentVol = new Map<string, number>();
      for (const [pair, ticker] of this.tickers) currentVol.set(pair, ticker.quoteVol);
      appendVolHistory(ranked, currentVol);
      // Anomaly desc first (pairs with ≥2 history samples), absolute volume
      // after — first-run behavior ≡ the old absolute ranking (anomaly = 1).
      ranked.sort((a, b) => {
        if (a.hasHistory !== b.hasHistory) return a.hasHistory ? -1 : 1;
        if (a.anomaly !== b.anomaly) return b.anomaly - a.anomaly;
        return b.quoteVol - a.quoteVol;
      });
      let pool = ranked.slice(0, UNIVERSE_POOL);
      // §2.2 — ONE batched call buys the 24h trade count for the whole pool;
      // thin tapes (a bot painting one pair) stay out of the universe.
      // HONEST: if the batched call fails, the count floor is skipped THIS
      // cycle rather than emptying the universe — thin tapes may slip in
      // until the next 5-minute refresh succeeds.
      if (pool.length > 0) {
        try {
          const symbols = pool.map((c) => c.pair);
          const path = `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
          const payload = await this.restFetch(path, 10_000);
          if (Array.isArray(payload)) {
            const counts = new Map<string, number>();
            for (const t of payload as Array<Record<string, unknown>>) {
              if (t && typeof t.symbol === "string") counts.set(t.symbol.toUpperCase(), num(t.count));
            }
            pool = pool.filter((c) => (counts.get(c.pair) ?? 0) >= UNIVERSE_MIN_TRADE_COUNT);
          }
        } catch {
          /* batched ticker call failed — count floor skipped this cycle */
        }
      }
      const next = pool.slice(0, UNIVERSE_LIMIT).map((c) => c.pair);
      if (next.length === 0) return;
      // BTC + ETH always on the tape — the V2 market-regime filter reads BTC.
      for (const anchor of ["BTCUSDT", "ETHUSDT"]) {
        if (!next.includes(anchor) && this.tickers.has(anchor)) next.push(anchor);
      }
      const changed = next.some((p) => !this.universe.includes(p)) || next.length !== this.universe.length;
      this.universe = next;
      // Drop state for pairs that left (keep subscribed extras).
      const keep = new Set([...next, ...this.extraPairs]);
      for (const pair of this.buckets.keys()) {
        if (!keep.has(pair)) {
          this.buckets.delete(pair);
          this.sessionHighs.delete(pair);
          this.prevRvol.delete(pair);
          this.bootstrapped.delete(pair);
          this.walls.delete(pair);
          this.wallTracks.delete(pair);
          this.wallBreaks.delete(pair);
          this.futures.delete(pair);
          this.historyBlocksByPair.delete(pair);
          this.firstCandleMs.delete(pair);
        }
      }
      this.wallQueue = this.wallQueue.filter((p) => keep.has(p));
      this.futuresQueue = this.futuresQueue.filter((p) => keep.has(p));
      if (changed || !this.wsB) {
        // (Re)open the trade stream with the current universe.
        const wanted = this.streamList();
        if (wanted.length > 0) {
          try {
            this.wsB?.close();
          } catch {
            /* ignore */
          }
          this.wsB = null;
          this.openWebSocketB(wanted);
        }
      }
      for (const pair of next) void this.bootstrapPair(pair);
    } finally {
      this.universeRefreshing = false;
    }
  }

  // ── Pair subscription (the coin sheet) ──────────────────────────────────────

  subscribePair(pair: string) {
    const clean = pair.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!clean.endsWith("USDT") || clean.length <= 5) return;
    if (this.extraPairs.has(clean)) return;
    this.extraPairs.add(clean);
    void this.bootstrapPair(clean);
    if (this.wsB && this.wsB.readyState === WebSocket.OPEN) {
      try {
        this.wsB.send(JSON.stringify({ method: "SUBSCRIBE", params: [`${clean.toLowerCase()}@aggTrade`], id: Date.now() }));
      } catch {
        /* stream will pick it up on the next universe refresh */
      }
    } else {
      // No stream yet (or reconnecting) — open one including the extra.
      try {
        this.wsB?.close();
      } catch {
        /* ignore */
      }
      this.wsB = null;
      this.openWebSocketB(this.streamList());
    }
  }

  unsubscribePair(pair: string) {
    const clean = pair.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!this.extraPairs.delete(clean)) return;
    if (this.universe.includes(clean)) return; // still scanned as universe member
    this.buckets.delete(clean);
    this.sessionHighs.delete(clean);
    this.prevRvol.delete(clean);
    this.bootstrapped.delete(clean);
    this.missingPairs.delete(clean);
    this.walls.delete(clean);
    this.wallTracks.delete(clean);
    this.wallBreaks.delete(clean);
    this.futures.delete(clean);
    this.historyBlocksByPair.delete(clean);
    this.firstCandleMs.delete(clean);
    this.wallQueue = this.wallQueue.filter((p) => p !== clean);
    this.futuresQueue = this.futuresQueue.filter((p) => p !== clean);
    if (this.wsB && this.wsB.readyState === WebSocket.OPEN) {
      try {
        this.wsB.send(JSON.stringify({ method: "UNSUBSCRIBE", params: [`${clean.toLowerCase()}@aggTrade`], id: Date.now() }));
      } catch {
        /* the periodic universe refresh resyncs the stream list */
      }
    }
  }

  // ── Row construction (mirrors the server scanner) ──────────────────────────

  private buildRow(pair: string): RadarRow | null {
    const buckets = this.buckets.get(pair);
    const ticker = this.tickers.get(pair);
    if (!buckets || !ticker) return null;
    const minute = Math.floor(Date.now() / 60_000);
    const minutes = [...buckets.keys()].sort((a, b) => a - b);
    const closed = minutes.filter((m) => m < minute); // completed minutes only
    if (closed.length < 15) return null; // not enough history yet
    const price = this.lastPrices.get(pair) ?? ticker.price;
    if (price <= 0) return null;

    const bucketAt = (m: number) => buckets.get(m);
    const closes = closed.map((m) => bucketAt(m)?.c ?? 0);
    // The live price is the close of the forming candle — same as Binance's
    // own kline stream semantics.
    const series = [...closes, price];

    const move = (count: number) => {
      const start = series[series.length - 1 - count] ?? 0;
      const end = price;
      return start === 0 ? 0 : ((end - start) / start) * 100;
    };
    const change1m = move(1);
    const change5m = move(5);
    const change15m = move(15);

    // Trailing 5m volume/trades/buys: last 4 closed minutes + forming minute.
    const recentMinutes = minutes.slice(-5);
    let vol5m = 0;
    let trades5m = 0;
    let buy5m = 0;
    for (const m of recentMinutes) {
      const b = bucketAt(m);
      if (!b) continue;
      vol5m += b.qv;
      trades5m += b.tr;
      buy5m += b.tb;
    }

    // §2.3 — baseline from 5m blocks over the prior 24h: time-of-day adjusted
    // (same-hour-of-day median when ≥6 samples), self-excluded (last 6
    // blocks dropped so the spike never dilutes its own baseline), floored at
    // mean/20 so a fresh listing can't produce infinite rvol. The old
    // mean-over-prior-hour did none of that.
    const closedMinutes = closed.map((m) => {
      const b = bucketAt(m);
      return { minute: m, qv: b?.qv ?? 0 };
    });
    const volBlocks = fiveMinuteBlocks(closedMinutes);
    const baseline = volumeBaseline(volBlocks, 6, 6);
    const volAvg5m = baseline.baseline;
    const rvol = volAvg5m > 0 ? vol5m / volAvg5m : 0;
    // Trade-count baseline: median trades per 5m block over the SAME
    // self-excluded window (approximation documented in baseline.ts §2.3),
    // floored at 1 so a near-zero tape can't produce an infinite spike.
    const tradesPerBlock = new Map<number, number>();
    for (const m of closed) {
      const b = bucketAt(m);
      const block = Math.floor(m / 5);
      tradesPerBlock.set(block, (tradesPerBlock.get(block) ?? 0) + (b?.tr ?? 0));
    }
    const tradeBlocks = [...tradesPerBlock.entries()].sort((a, b) => a[0] - b[0]).map(([, tr]) => tr);
    const tradeAvg5m = Math.max(1, median(tradeBlocks.slice(0, Math.max(0, tradeBlocks.length - 6))));
    const tradeSpike = trades5m / tradeAvg5m;
    const buyPct = vol5m > 0 ? (buy5m / vol5m) * 100 : 50;

    // ATR first — §7's close-strength weighting needs it below.
    const candleSeries = closed.slice(-15).map((m) => {
      const b = bucketAt(m);
      return { high: b?.h ?? price, low: b?.l ?? price, close: b?.c ?? price };
    });
    candleSeries.push({ high: price, low: price, close: price });
    const atrPct = atrPctFromCandles(candleSeries, 14);

    // §7 — range-weighted close strength: raw = (c−l)/(h−l), weighted by the
    // minute's range vs 2×ATR so a tight doji contributes ~0.5 (noise) and a
    // wide impulse candle counts fully. Averaged over the last 5 closed
    // minutes; the old unweighted version let choppy micro-candles vote.
    let strengthSum = 0;
    let strengthCount = 0;
    for (const m of closed.slice(-5)) {
      const b = bucketAt(m);
      if (!b || b.c <= 0) continue;
      const range = b.h - b.l;
      const raw = range > 0 ? (b.c - b.l) / range : 0.5;
      const rangePct = (range / b.c) * 100;
      const w = atrPct !== null && atrPct > 0 ? Math.min(1, rangePct / (2 * atrPct)) : 0.5;
      strengthSum += 0.5 + (raw - 0.5) * w;
      strengthCount += 1;
    }
    const closeStrength = strengthCount > 0 ? strengthSum / strengthCount : 0.5;

    // §2.6 — session high anchored to the miniTicker's rolling 24h `h` (the
    // true 24h high), so restarts/reloads can never reset it. Bucket highs
    // (≈ last 24h, pruned) and the live price only ever raise it;
    // this.sessionHighs stays a fast cache.
    let bucketHigh = 0;
    for (const m of closed) {
      const b = bucketAt(m);
      if (b && b.h > bucketHigh) bucketHigh = b.h;
    }
    const sessionHigh = Math.max(ticker.high, bucketHigh, price);
    this.sessionHighs.set(pair, sessionHigh);
    const belowHighPct = sessionHigh > 0 ? ((sessionHigh - price) / sessionHigh) * 100 : 0;

    const volumeLead = rvol >= 3 && Math.abs(change5m) <= 1 && Math.abs(change1m) <= 1;
    const prev = this.prevRvol.get(pair) ?? null;
    this.prevRvol.set(pair, rvol);
    const spikeFalling = prev !== null && prev >= 3 && rvol < 1.5;

    const score = pumpScore(rvol, tradeSpike, change1m, change5m, change15m, buyPct, closeStrength);
    const change24h = ticker.changePct;

    // §2.3/§8 — usable baseline blocks feed the engine's rvol-trust gate
    // (V2Input.historyBlocks); RadarRow has no field for it, so it travels
    // on this side channel and is read in the assessment pass.
    this.historyBlocksByPair.set(pair, baseline.blocks);

    const row: RadarRow = {
      pair,
      base: pair.slice(0, -4),
      price,
      change1m,
      change5m,
      change15m,
      change24h,
      volume24h: ticker.quoteVol,
      vol5mUsd: vol5m,
      volAvg5mUsd: volAvg5m,
      rvol,
      tradeSpike,
      trades5m: Math.round(trades5m),
      buyPct,
      closeStrength,
      score,
      sessionHigh,
      belowHighPct,
      badge: badgeFor(score, rvol, change24h, belowHighPct),
      volumeLead,
      spikeFalling,
      signal: "flat",
      spark: series.slice(-60),
      atrPct,
      v2: null,
    };
    row.signal = decideSignal(row);
    return row;
  }

  // ── §3.4/§4 — per-pair flow inputs from the 1m buckets ─────────────────────

  private flowExtras(row: RadarRow): {
    beta: number | null;
    residChange5m: number | null;
    residChange15m: number | null;
    cvdSlope15m: number | null;
    avgTradeSizeSpike: number | null;
  } {
    const nothing = { beta: null, residChange5m: null, residChange15m: null, cvdSlope15m: null, avgTradeSizeSpike: null };
    const buckets = this.buckets.get(row.pair);
    if (!buckets) return nothing;
    const minute = Math.floor(Date.now() / 60_000);
    const minutes = [...buckets.keys()].filter((m) => m < minute).sort((a, b) => a - b);

    // §4 — CVD slope: net taker pressure over the last 15 closed minutes.
    // Price up + negative slope = distribution into strength — the best free
    // short-term warning there is.
    const cvdSlope15m = cvdSlope(
      minutes.slice(-15).map((m) => {
        const b = buckets.get(m);
        return { qv: b?.qv ?? 0, tb: b?.tb ?? 0 };
      }),
      15,
    );

    // §4 — trade-size skew: avg print size over the last 5 closed minutes vs
    // the median per-minute size of the prior hour (last 5 excluded so the
    // whale minutes don't define their own baseline; tr=0 minutes skipped).
    let qv5 = 0;
    let tr5 = 0;
    for (const m of minutes.slice(-5)) {
      const b = buckets.get(m);
      if (!b) continue;
      qv5 += b.qv;
      tr5 += b.tr;
    }
    const lastAvgSize = tr5 > 0 ? qv5 / tr5 : 0;
    const priorSizes: number[] = [];
    for (const m of minutes.slice(-65, -5)) {
      const b = buckets.get(m);
      if (b && b.tr > 0) priorSizes.push(b.qv / b.tr);
    }
    const avgTradeSizeSpike = sizeSpike(lastAvgSize, median(priorSizes));

    // §3.4 — beta + residual momentum vs BTC (BTC anchors the universe).
    // Closes are aligned by ABSOLUTE minute: index alignment would silently
    // misalign pairs whose bootstraps cover different windows.
    let beta: number | null = null;
    let residChange5m: number | null = null;
    let residChange15m: number | null = null;
    if (row.pair !== "BTCUSDT") {
      const btcBuckets = this.buckets.get("BTCUSDT");
      if (btcBuckets) {
        const coinCloses: number[] = [];
        const btcCloses: number[] = [];
        for (const m of minutes.slice(-60)) {
          const cb = buckets.get(m);
          const bb = btcBuckets.get(m);
          if (cb && bb && cb.c > 0 && bb.c > 0) {
            coinCloses.push(cb.c);
            btcCloses.push(bb.c);
          }
        }
        beta = betaFromCloses(coinCloses, btcCloses, 40);
        if (beta !== null && this.btcContext) {
          residChange5m = row.change5m - beta * this.btcContext.change5m;
          residChange15m = row.change15m - beta * this.btcContext.change15m;
        }
      }
    }
    return { beta, residChange5m, residChange15m, cvdSlope15m, avgTradeSizeSpike };
  }

  // ── Signals ────────────────────────────────────────────────────────────────

  /** Build + bookkeep one fired signal (cooldown map + ledger entries). */
  private fire(row: RadarRow, type: SignalType, now: number): TrackedSignal {
    const plan = type === "go_long" ? row.v2?.trade ?? null : type === "go_short" ? row.v2?.shortTrade ?? null : null;
    const signal: TrackedSignal = {
      id: `${row.pair}:${type}:${Math.floor(now / 60_000)}`,
      pair: row.pair,
      base: row.base,
      type,
      direction: DIRECTION[type],
      score: type === "go_long" ? row.v2?.longScore ?? row.score : type === "go_short" ? row.v2?.shortScore ?? row.score : row.score,
      price: row.price,
      change24h: row.change24h,
      rvol: row.rvol,
      buyPct: row.buyPct,
      volume24h: row.volume24h,
      note: signalNote(type, row),
      createdAt: new Date(now).toISOString(),
      sl: plan ? plan.stop : null,
      tp1: plan ? plan.tp1 : null,
      tp2: plan ? plan.tp2 : null,
      atrPct: plan ? plan.atrPct : null,
      price5m: null,
      change5m: null,
      price15m: null,
      change15m: null,
      price60m: null,
      change60m: null,
      mfe: null,
      mae: null,
      status: "pending",
      lastPriceAt: now,
      // §5.2 — the kill switch grades this signal's 60m outcome in R later.
      riskPct: plan ? plan.riskPct : null,
    };
    this.cooldowns.set(`${row.pair}:${type}`, now);
    if (BEARISH_TYPES.includes(type)) this.ledger.bearishSignal(row.pair, now);
    if (type === "go_long") this.ledger.longSignal(row.pair, now);
    if (type === "go_short") this.ledger.shortSignal(row.pair, now);
    return signal;
  }

  private detectSignals(rows: RadarRow[]): TrackedSignal[] {
    const now = Date.now();
    const fired: TrackedSignal[] = [];
    // §5.2 — the guard correlates a candidate against every open position's
    // spark, so it needs the whole board's sparks.
    const sparksMap = new Map(rows.map((r) => [r.pair, r.spark]));

    // §10 — GO candidates fire in UNCAPPED v2-score order (rankForSignalCut)
    // BEFORE the per-scan cap: the old cut landed on base-score row order,
    // which says nothing about GO priority.
    type GoCandidate = { row: RadarRow; type: SignalType; score: number; pair: string };
    const goCandidates: GoCandidate[] = [];
    for (const row of rows) {
      const v2 = row.v2;
      if (!v2) continue;
      // V2 gated signals — the verdict plus the anti-flip-flop ledger have to
      // agree before the app says "go".
      if (v2.verdict === "go_long" && this.ledger.longAllowed(row.pair, now) && !this.ledger.repeatLong(row.pair, now)) {
        goCandidates.push({ row, type: "go_long", score: v2.longScore, pair: row.pair });
      }
      if (v2.verdict === "go_short" && this.ledger.shortAllowed(row.pair, now) && !this.ledger.repeatShort(row.pair, now)) {
        goCandidates.push({ row, type: "go_short", score: v2.shortScore, pair: row.pair });
      }
    }
    for (const cand of rankForSignalCut(goCandidates)) {
      if (fired.length >= MAX_SIGNALS_PER_SCAN) break;
      const { row, type } = cand;
      if (now - (this.cooldowns.get(`${row.pair}:${type}`) ?? 0) < V2.signalRepeatMs) continue;
      // §5.2 — portfolio layer: concurrency cap, correlation between open
      // positions, kill switch. A veto is NOT silent: it goes to the shadow
      // log with gate "portfolio"/"kill-switch" and gets graded like any
      // other would-be GO.
      const side = DIRECTION[type];
      const decision = this.guard.allow(row.pair, side, row.spark, sparksMap, now);
      if (!decision.ok) {
        this.logShadow(row.pair, side, this.guard.killed(now) ? "kill-switch" : "portfolio", row.price);
        continue;
      }
      fired.push(this.fire(row, type, now));
      this.guard.register(row.pair, side, row.spark, now);
    }

    // Legacy heuristic signals — existing behavior, existing row order.
    for (const row of rows) {
      if (fired.length >= MAX_SIGNALS_PER_SCAN) return fired;
      const candidates: SignalType[] = [];
      const flatDay = row.change24h >= -5 && row.change24h <= 8;
      const flatNow = Math.abs(row.change1m) <= 1 && Math.abs(row.change5m) <= 1;

      if (row.score >= 80 && row.change5m > 0 && row.change24h <= 8) candidates.push("pump_start");
      if (row.rvol >= 3 && flatNow && flatDay) candidates.push("volume_lead");
      if (flatDay && flatNow && row.rvol >= 2 && row.buyPct >= 70) candidates.push("buyer_pressure");
      if (flatDay && flatNow && row.rvol >= 2 && row.buyPct <= 30) candidates.push("seller_pressure");
      if (row.belowHighPct >= 3 && row.rvol >= 2 && row.change5m < 0) candidates.push("dump_start");
      if (row.spikeFalling) candidates.push("spike_collapse");

      for (const type of candidates) {
        if (fired.length >= MAX_SIGNALS_PER_SCAN) return fired;
        const key = `${row.pair}:${type}`;
        const last = this.cooldowns.get(key) ?? 0;
        if (now - last < SIGNAL_COOLDOWN_MS) continue;
        fired.push(this.fire(row, type, now));
      }
    }
    return fired;
  }

  // ── Outcome grading (5 / 15 / 60 minutes later, plus running MFE/MAE) ─────

  private gradeOutcomes(prices: Map<string, number>) {
    if (this.tracked.length === 0) return;
    const now = Date.now();
    let logChanged = false;

    for (const s of this.tracked) {
      const price = prices.get(s.pair);
      const createdAt = new Date(s.createdAt).getTime();
      const age = now - createdAt;

      if (price !== undefined && price > 0) {
        const raw = (price / s.price - 1) * 100;
        const favorable = s.direction === "long" ? raw : -raw;
        s.mfe = Math.max(s.mfe ?? -Infinity, favorable);
        s.mae = Math.min(s.mae ?? Infinity, favorable);
        logChanged = true;
      }

      if (age >= 5 * 60_000 && s.change5m === null && price !== undefined) {
        s.price5m = price;
        s.change5m = (price / s.price - 1) * 100;
        logChanged = true;
      }
      if (age >= 15 * 60_000 && s.change15m === null && price !== undefined) {
        s.price15m = price;
        s.change15m = (price / s.price - 1) * 100;
        logChanged = true;
      }
      if (age >= OUTCOME_HORIZON_MS && s.status !== "final" && price !== undefined) {
        s.price60m = price;
        s.change60m = (price / s.price - 1) * 100;
        s.status = "final";
        logChanged = true;
        // §5.2 — feed the portfolio guard's kill switch: the final 60m
        // outcome of every tracked GO, direction-adjusted and expressed in
        // units of its own plan risk (R). Old signals without a stored
        // riskPct grade against R=1 (percent ≈ R there).
        if (s.type === "go_long" || s.type === "go_short") {
          const raw = (price / s.price - 1) * 100;
          const favorable = s.direction === "long" ? raw : -raw;
          const riskPct = typeof s.riskPct === "number" && s.riskPct > 0 ? s.riskPct : 1;
          this.guard.registerOutcome(favorable / riskPct, now);
        }
      }
      if (price !== undefined) s.lastPriceAt = now;
      if (s.status === "pending" && (s.change5m !== null || s.change15m !== null)) s.status = "partial";
      this.dirtyOutcomes.push({ ...s });
    }

    // Keep memory bounded; the log holds history.
    this.tracked = this.tracked.filter((s) => s.status !== "final" || now - new Date(s.createdAt).getTime() < 2 * 60 * 60_000);

    if (logChanged) {
      // Persist to the local log (merge with existing entries).
      const byId = new Map(readLocalSignals().map((s) => [s.id, s]));
      for (const s of this.tracked) byId.set(s.id, s);
      writeLocalSignals([...byId.values()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    }
  }

  private flushOutcomes() {
    if (this.dirtyOutcomes.length === 0) return;
    const updates = this.dirtyOutcomes.splice(0, 100).map((s) => ({
      id: s.id,
      price5m: s.price5m,
      change5m: s.change5m,
      price15m: s.price15m,
      change15m: s.change15m,
      price60m: s.price60m,
      change60m: s.change60m,
      mfe: s.mfe,
      mae: s.mae,
      status: s.status,
    }));
    void postIngest({ mode: "outcome", updates });
  }

  // ── Live shadow log (§6) — append + 60m grading ─────────────────────────────

  /** Append a shadow entry (deduped ≥30 min per pair:side:gate) and queue it
   *  for the 60m direction-adjusted grade. */
  private logShadow(pair: string, side: "long" | "short", gate: string, price: number): void {
    const now = Date.now();
    const log = readShadowLog(); // ensures the dedupe seed ran (reload case)
    const key = `${pair}:${side}:${gate}`;
    if (now - (shadowLastLogged.get(key) ?? -Infinity) < SHADOW_DEDUPE_MS) return;
    shadowLastLogged.set(key, now);
    writeShadowLog([{ pair, side, gate, at: new Date(now).toISOString(), price, change60m: null }, ...log]);
    if (this.shadowPending.length < 200) this.shadowPending.push({ pair, side, gate, atMs: now, price });
  }

  /** Grade pending shadow entries once they turn 60m old (§6). */
  private gradeShadow(prices: Map<string, number>) {
    if (this.shadowPending.length === 0) return;
    const now = Date.now();
    const still: PendingShadow[] = [];
    let changed = false;
    const log = readShadowLog();
    for (const pending of this.shadowPending) {
      const age = now - pending.atMs;
      if (age < OUTCOME_HORIZON_MS) {
        still.push(pending);
        continue;
      }
      const price = prices.get(pending.pair);
      if (price === undefined || price <= 0) {
        // No tape for the pair (left the universe) — grace period, then the
        // entry simply stays ungraded instead of blocking the queue forever.
        if (age < 3 * OUTCOME_HORIZON_MS) still.push(pending);
        continue;
      }
      const raw = (price / pending.price - 1) * 100;
      const change60m = pending.side === "long" ? raw : -raw;
      const at = new Date(pending.atMs).toISOString();
      for (const entry of log) {
        if (entry.change60m === null && entry.pair === pending.pair && entry.side === pending.side && entry.gate === pending.gate && entry.at === at) {
          entry.change60m = change60m;
          changed = true;
          break;
        }
      }
    }
    this.shadowPending = still;
    if (changed) writeShadowLog(log);
  }

  // ── Order book walls (subscribed + candidate pairs) ──────────────────────

  private async pollWalls(pair: string, price: number) {
    if (price <= 0) return;
    const cached = this.walls.get(pair);
    if (cached && Date.now() - cached.at < WALL_TTL_MS) return;
    try {
      // §2.5 — 100 levels: the ±2% wall band AND the +7% TP2 runway both need
      // more depth than the old 20-level peek could see.
      const payload = (await this.restFetch(`/api/v3/depth?symbol=${pair}&limit=100`, 8_000)) as {
        asks?: Array<[string, string]>;
        bids?: Array<[string, string]>;
      };
      const asks = Array.isArray(payload.asks) ? payload.asks : [];
      const bids = Array.isArray(payload.bids) ? payload.bids : [];
      // §3.2/§4 — one shared analyzer (baseline.ts) for walls, spread,
      // depth-to-TP2 and wall-share-of-book: browser and server can't drift.
      const depth = analyzeDepth(asks, bids, price, V2.wallScanPct);
      this.walls.set(pair, {
        at: Date.now(),
        ask: depth.askWall,
        bid: depth.bidWall,
        spreadBps: depth.spreadBps,
        askDepthUsd: depth.askDepthUsd,
        askWallToDepth: depth.askWallToDepth,
        bidWallToDepth: depth.bidWallToDepth,
      });
      // §4 — wall persistence: a 5-second wall is probably spoofed; only an
      // aged one earns the full "unbreakable" penalty in the engine.
      trackWallAge(this.wallTracks, pair, depth.askWall, Date.now());
    } catch {
      /* feed hiccup — keep the last known walls */
    }
  }

  private wallSnapshot(pair: string): {
    ask: V2Wall;
    bid: V2Wall;
    spreadBps: number | null;
    askDepthUsd: number;
    askWallToDepth: number | null;
    bidWallToDepth: number | null;
    known: boolean;
  } {
    const cached = this.walls.get(pair);
    if (!cached || Date.now() - cached.at > WALL_KNOWN_MS) {
      return { ask: null, bid: null, spreadBps: null, askDepthUsd: 0, askWallToDepth: null, bidWallToDepth: null, known: false };
    }
    return {
      ask: cached.ask,
      bid: cached.bid,
      spreadBps: cached.spreadBps,
      askDepthUsd: cached.askDepthUsd,
      askWallToDepth: cached.askWallToDepth,
      bidWallToDepth: cached.bidWallToDepth,
      known: true,
    };
  }

  /** §4 — age of the tracked ASK wall in seconds (null when unknown or when
   *  the cached wall no longer matches the tracked price — a wall that moved
   *  is a new wall; trackWallAge reseeds it at the next poll). */
  private askWallAgeSec(pair: string, ask: V2Wall): number | null {
    if (ask === null) return null;
    const track = this.wallTracks.get(pair);
    if (!track) return null;
    if (Math.abs(track.price - ask.price) / ask.price > 0.0005) return null;
    return Math.max(0, (Date.now() - track.firstSeenAt) / 1000);
  }

  private wallBreakState(pair: string, price: number, ask: V2Wall): boolean | null {
    if (ask === null) return null;
    let track = this.wallBreaks.get(pair);
    if (!track || Math.abs(track.wallPrice - ask.price) / ask.price > 0.001) {
      track = { wallPrice: ask.price, aboveSince: null };
      this.wallBreaks.set(pair, track);
    }
    if (price > ask.price) {
      if (track.aboveSince === null) track.aboveSince = Date.now();
      return Date.now() - track.aboveSince >= V2.wallConfirmMs;
    }
    track.aboveSince = null;
    return false;
  }

  /** V2.2 — wall-absence confirmation: how long has the book shown NO wall in
   *  the scan band on this side? The "+8 runway" accrues only after 30 s of
   *  continuous fresh absence — pulled-and-republished walls can't oscillate. */
  private trackWallAbsence(map: Map<string, number>, pair: string, known: boolean, wall: V2Wall, nowMs: number): number | null {
    if (known && wall === null) {
      const since = map.get(pair);
      if (since === undefined) {
        map.set(pair, nowMs);
        return 0;
      }
      return nowMs - since;
    }
    map.delete(pair); // wall reappeared, data went stale, or never known
    return null;
  }

  /** Pairs worth extra REST attention (walls + futures): GO/watch candidates
   *  and anything scoring like one, plus the coin-sheet subscriptions. */
  private restCandidates(rows: RadarRow[]): string[] {
    return rows
      .filter((r) => r.score >= 50 || (r.v2 !== null && (r.v2.verdict === "go_long" || r.v2.verdict === "go_short" || r.v2.verdict === "watch")))
      .slice(0, WALL_CANDIDATE_LIMIT)
      .map((r) => r.pair);
  }

  // Paced wall queue: one depth request per compute tick (~1/s), rotating
  // through candidates + subscribed pairs. Browser-side, single user, so the
  // weight budget is generous — still, pace beats burst.
  private pumpWallQueue(rows: RadarRow[]) {
    const now = Date.now();
    const wanted = [...new Set([...this.extraPairs, ...this.restCandidates(rows)])];
    for (const pair of wanted) {
      if (this.wallQueue.includes(pair)) continue;
      const cached = this.walls.get(pair);
      if (!cached || now - cached.at > WALL_TTL_MS) this.wallQueue.push(pair);
    }
    if (this.wallInFlight || this.wallQueue.length === 0) return;
    const pair = this.wallQueue.shift();
    if (!pair) return;
    const row = rows.find((r) => r.pair === pair);
    const price = row?.price ?? this.lastPrices.get(pair) ?? 0;
    if (price <= 0) return;
    this.wallInFlight = true;
    void this.pollWalls(pair, price).finally(() => {
      this.wallInFlight = false;
    });
  }

  // ── §9 — futures positioning, paced like the wall queue ─────────────────────

  private freshFutures(pair: string): FuturesSnapshot | null {
    const cached = this.futures.get(pair);
    if (!cached || Date.now() - cached.at > 2 * FUT_CACHE_MS) return null;
    return cached;
  }

  private pumpFuturesQueue(rows: RadarRow[]) {
    if (this.fapiInFlight) return;
    const now = Date.now();
    const wanted = [...new Set([...this.extraPairs, ...this.restCandidates(rows)])];
    this.futuresQueue = this.futuresQueue.filter((p) => wanted.includes(p));
    for (const pair of wanted) {
      if (this.futuresQueue.includes(pair)) continue;
      const cached = this.futures.get(pair);
      if (!cached || now - cached.at >= FUT_CACHE_MS) this.futuresQueue.push(pair);
    }
    const pair = this.futuresQueue.shift();
    if (!pair) return;
    this.fapiInFlight = true;
    void this.pollFutures(pair).finally(() => {
      this.fapiInFlight = false;
    });
  }

  private async pollFutures(pair: string): Promise<void> {
    // Best-effort by design: CORS block, no perp contract for this spot pair,
    // or a hiccup → nulls cached for 60s; the engine treats null as "no
    // data", never as "fine". Silent by the same policy as every other feed.
    let funding: number | null = null;
    let oi: number | null = null;
    let ls: number | null = null;
    const settled = await Promise.allSettled([
      this.fapiFetch(`/fapi/v1/premiumIndex?symbol=${pair}`),
      this.fapiFetch(`/futures/data/openInterestHist?symbol=${pair}&period=5m&limit=4`),
      this.fapiFetch(`/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=5m&limit=1`),
    ]);
    const premium = settled[0];
    if (premium.status === "fulfilled" && premium.value && typeof premium.value === "object" && !Array.isArray(premium.value)) {
      const rate = num((premium.value as Record<string, unknown>).lastFundingRate, NaN);
      if (Number.isFinite(rate)) funding = rate * 100; // fraction → % per 8h
    }
    const oiHist = settled[1];
    if (oiHist.status === "fulfilled" && Array.isArray(oiHist.value)) {
      const entries = oiHist.value as Array<Record<string, unknown>>;
      const first = num(entries[0]?.sumOpenInterestValue, 0);
      const last = num(entries[entries.length - 1]?.sumOpenInterestValue, 0);
      if (entries.length >= 2 && first > 0) oi = ((last - first) / first) * 100;
    }
    const lsHist = settled[2];
    if (lsHist.status === "fulfilled" && Array.isArray(lsHist.value)) {
      const entries = lsHist.value as Array<Record<string, unknown>>;
      const ratio = num(entries[0]?.longShortRatio, NaN);
      if (Number.isFinite(ratio) && ratio > 0) ls = ratio;
    }
    this.futures.set(pair, { at: Date.now(), funding, oi, ls });
  }

  // ── §8 — calibration from the Backtest UI ───────────────────────────────────

  private loadCalibration(): void {
    try {
      const raw = localStorage.getItem(CALIBRATION_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { bins?: unknown }).bins)) {
        const cal = parsed as Calibration;
        const binsOk = cal.bins.every(
          (b) =>
            b !== null &&
            typeof b === "object" &&
            typeof b.scoreMin === "number" &&
            typeof b.n === "number" &&
            typeof b.decided === "number" &&
            typeof b.hitRate === "number",
        );
        this.calibration = binsOk ? cal : null;
      } else {
        this.calibration = null;
      }
    } catch {
      this.calibration = null; // corrupt/absent — engine runs uncalibrated
    }
  }

  // ── The compute tick — pure computation over the live stores ────────────────
  //
  // V2.2 (audit Part B.5): the 1 s tick stays for PRICE display; the VERDICT
  // advances only every 3rd tick (3 s) through the stateful layer, and the
  // emitted verdict is always the state machine's — never the raw snapshot's.

  private compute() {
    if (!this.running) return;
    this.computeTick += 1;
    const verdictTick = this.computeTick % VERDICT_EVERY_N_COMPUTES === 0;
    const nowMs = Date.now();
    const pairs = [...new Set([...this.universe, ...this.extraPairs])];
    const rows: RadarRow[] = [];
    const prices = new Map<string, number>();
    for (const pair of pairs) {
      if (this.missingPairs.has(pair)) continue;
      const row = this.buildRow(pair);
      if (row) {
        rows.push(row);
        prices.set(row.pair, row.price);
      }
    }
    if (rows.length === 0) return;

    // BTC market regime — V2.2: DWELLED with an ATR deadband (0.5 × enter,
    // 0.3 × exit, 15 s persistence). One BTC tick can no longer flip every
    // verdict in the market, and a flip now SHORTENS directional blocks to
    // ≤10 min instead of clearing them (the burst amplifier, twice dead).
    const btcRow = rows.find((r) => r.pair === "BTCUSDT") ?? null;
    const btcAtr15m = atrWindow(btcRow?.atrPct ?? null, 15);
    const prevRegimeMode = this.btcRegime?.mode ?? null;
    this.btcRegime = nextBtcRegime(this.btcRegime, btcRow?.change15m ?? null, btcAtr15m, nowMs);
    if (btcRow) {
      const spark0 = btcRow.spark[0] ?? btcRow.price;
      this.btcContext = {
        price: btcRow.price,
        change5m: btcRow.change5m,
        change15m: btcRow.change15m,
        change1h: spark0 > 0 ? ((btcRow.price - spark0) / spark0) * 100 : 0,
        change24h: btcRow.change24h,
        mode: this.btcRegime.mode,
      };
      if (prevRegimeMode !== null && prevRegimeMode !== this.btcRegime.mode) {
        this.ledger.shortenDirectional(10 * 60_000, nowMs);
      }
      this.lastBtcMode = this.btcRegime.mode;
    }

    // V2 assessment on every row; wall/futures/flow data where the paced
    // queues have reached. rowInputFromRadar is the SAME adapter the server
    // scanner feeds — one input contract, two tiers, zero drift.
    for (const row of rows) {
      const wall = this.wallSnapshot(row.pair);
      const flow = this.flowExtras(row);
      const fut = this.freshFutures(row.pair);
      // V2.2 — depth age + wall-absence confirmation clocks.
      const cachedWall = this.walls.get(row.pair);
      const wallDataAgeMs = cachedWall !== undefined ? Math.max(0, nowMs - cachedWall.at) : null;
      const askAbsentMs = this.trackWallAbsence(this.askAbsentSince, row.pair, wall.known, wall.ask, nowMs);
      const bidAbsentMs = this.trackWallAbsence(this.bidAbsentSince, row.pair, wall.known, wall.bid, nowMs);
      // V2.2 — data age: the stalest verdict input (tape/buckets, and the
      // depth snapshot when one exists). Transitions freeze past 3× cadence.
      const tapeAge = this.lastTapeMs.has(row.pair) ? Math.max(0, nowMs - (this.lastTapeMs.get(row.pair) ?? nowMs)) : 0;
      const dataAgeMs = Math.max(tapeAge, wallDataAgeMs ?? 0);
      const isStable = isStableAsset(row.base, row.price, row.change15m, row.change24h);
      const priorLong = this.verdictLongStates.get(row.pair) ?? null;
      const priorShort = this.verdictShortStates.get(row.pair) ?? null;
      const priorLongGo = priorLong?.name === "go" || priorLong?.name === "demoting";
      const priorShortGo = priorShort?.name === "go" || priorShort?.name === "demoting";
      const input = rowInputFromRadar(row, {
        atrPct: row.atrPct,
        askWall: wall.ask,
        bidWall: wall.bid,
        askWallKnown: wall.known,
        wallBrokenConfirmed: this.wallBreakState(row.pair, row.price, wall.ask),
        btcChange15m: this.btcContext?.change15m ?? null,
        btcChange1h: this.btcContext?.change1h ?? null,
        isStablecoin: isStable,
        // §3.4 — beta + residual momentum (BTC anchors the tape).
        beta: flow.beta,
        residChange5m: flow.residChange5m,
        residChange15m: flow.residChange15m,
        btcChange5m: this.btcContext?.change5m ?? null,
        btcAtr15m,
        // §4 — flow microstructure.
        cvdSlope15m: flow.cvdSlope15m,
        avgTradeSizeSpike: flow.avgTradeSizeSpike,
        // §2.5/§3.2/§4 — book microstructure.
        spreadBps: wall.spreadBps,
        wallAgeSec: this.askWallAgeSec(row.pair, wall.ask),
        wallToDepthRatio: wall.askWallToDepth,
        askDepthToTp2Usd: wall.askDepthUsd > 0 ? wall.askDepthUsd : null,
        // §9 — futures positioning (nulls when fapi is unreachable / no perp).
        oiChange15m: fut?.oi ?? null,
        fundingRatePct: fut?.funding ?? null,
        lsRatio: fut?.ls ?? null,
        // §4/§2.3 — listing age + baseline-trust blocks.
        listingAgeDays: listingAgeDays(this.firstCandleMs.get(row.pair)),
        historyBlocks: this.historyBlocksByPair.get(row.pair) ?? null,
        // V2.2 — the verdict-layer feeds.
        btcModeOverride: this.btcRegime.mode,
        wallDataAgeMs,
        askWallAbsentMs: askAbsentMs,
        bidWallAbsentMs: bidAbsentMs,
      });
      const { row: v2, long: longAssess, short: shortAssess } = assessRowWithSides(input, this.calibration, {
        priorLongGo,
        priorShortGo,
      });
      // §8 — the engine fills hitRate from the user's calibration (or the
      // shipped measured default) and the expectancy gate reads the same
      // numbers, so the label and the verdict can never disagree.
      // §6 — live shadow log: every would-be GO the hard gates vetoed still
      // gets logged and graded, so the gates themselves stay accountable.
      // (Read from the RAW assessment — before the state overlay.)
      if (longAssess.verdict === "watch" && longAssess.demoteGate) this.logShadow(row.pair, "long", longAssess.demoteGate, row.price);
      if (shortAssess.verdict === "watch" && shortAssess.demoteGate) this.logShadow(row.pair, "short", shortAssess.demoteGate, row.price);
      // V2.2 — advance the state machines on the 3 s verdict tick only.
      let longState = priorLong;
      let shortState = priorShort;
      if (verdictTick) {
        longState = nextVerdictState(priorLong, "long", longAssess, this.btcRegime.mode, nowMs, dataAgeMs, this.liveCfg, isStable || this.guard.killed(nowMs));
        shortState = nextVerdictState(priorShort, "short", shortAssess, this.btcRegime.mode, nowMs, dataAgeMs, this.liveCfg, isStable || this.guard.killed(nowMs));
        this.verdictLongStates.set(row.pair, longState);
        this.verdictShortStates.set(row.pair, shortState);
        if (longState.name !== (priorLong?.name ?? "inactive")) {
          this.verdictChangeLog.unshift({
            pair: row.pair,
            side: "long",
            at: nowMs,
            from: priorLong?.name ?? "inactive",
            to: longState.name,
            scoreSmooth: longState.scoreSmooth,
            rawScore: v2.longScore,
            dataAgeMs,
            firstFailingGate: longAssess.demoteGate,
            reason: longState.lastChangeReason,
          });
          if (this.verdictChangeLog.length > 300) this.verdictChangeLog.length = 300;
        }
        if (shortState.name !== (priorShort?.name ?? "inactive")) {
          this.verdictChangeLog.unshift({
            pair: row.pair,
            side: "short",
            at: nowMs,
            from: priorShort?.name ?? "inactive",
            to: shortState.name,
            scoreSmooth: shortState.scoreSmooth,
            rawScore: v2.shortScore,
            dataAgeMs,
            firstFailingGate: shortAssess.demoteGate,
            reason: shortState.lastChangeReason,
          });
          if (this.verdictChangeLog.length > 300) this.verdictChangeLog.length = 300;
        }
      }
      // The overlay runs EVERY tick: the emitted verdict is always the state
      // machine's (held between verdict ticks), never the raw snapshot's.
      if (longState && shortState) {
        overlayVerdictState(v2, longAssess, shortAssess, longState, shortState, this.liveCfg, isStable);
      }
      v2.dataAgeMs = dataAgeMs;
      row.v2 = v2;
    }

    // V2.2 — pinned emission order: GO states first, pinned recent exits
    // second, then the rest by smoothed score. A visible coin can no longer
    // be bumped out of sight by a new candidate.
    rows.sort((a, b) => {
      const rankA = verdictSortRank(a.v2?.state ?? a.v2?.shortState ?? null, nowMs);
      const rankB = verdictSortRank(b.v2?.state ?? b.v2?.shortState ?? null, nowMs);
      if (rankA !== rankB) return rankA - rankB;
      const scoreA = a.v2?.state?.scoreSmooth ?? a.v2?.longScore ?? a.score;
      const scoreB = b.v2?.state?.scoreSmooth ?? b.v2?.longScore ?? b.score;
      return scoreB - scoreA || b.rvol - a.rvol;
    });
    // Keep the payload sane: full detail for the top 20 + subscribed pairs.
    rows.forEach((row, index) => {
      const v2 = row.v2;
      if (!v2) return;
      if (index > 20 && !this.extraPairs.has(row.pair)) {
        v2.checks = [];
        v2.shortChecks = [];
        v2.scenarios = [];
        v2.trade = null;
        v2.shortTrade = null;
      }
    });

    this.pumpWallQueue(rows);
    this.pumpFuturesQueue(rows);
    this.scans += 1;
    const snapshot: RadarSnapshot = {
      rows,
      updatedAt: new Date().toISOString(),
      universe: this.universe.length,
      clients: 1,
      scans: this.scans,
      stale: this.isStale(),
      btc: this.btcContext,
      stability: stabilityStats(this.verdictChangeLog, nowMs, { cadenceMs: this.liveCfg.scanCadenceMs }),
    };
    this.lastSnapshot = snapshot;
    this.listeners.onSnapshot?.(snapshot);

    // V2.2 — persist the verdict states (dwell/pin timers survive reloads).
    if (verdictTick && nowMs - this.stateSaveAt >= VERDICT_STATE_SAVE_MS) {
      this.stateSaveAt = nowMs;
      persistVerdictStates(this.verdictLongStates, this.verdictShortStates, this.btcRegime);
    }

    // Per-pair updates for subscribed coin sheets.
    for (const pair of this.extraPairs) {
      const row = rows.find((r) => r.pair === pair);
      if (row) {
        const wall = this.wallSnapshot(pair);
        this.listeners.onPairUpdate?.({
          pair: row.pair,
          base: row.base,
          price: row.price,
          change1m: row.change1m,
          change5m: row.change5m,
          change15m: row.change15m,
          change24h: row.change24h,
          volume24h: row.volume24h,
          vol5mUsd: row.vol5mUsd,
          volAvg5mUsd: row.volAvg5mUsd,
          rvol: row.rvol,
          trades5m: row.trades5m,
          buyPct: row.buyPct,
          score: row.score,
          sessionHigh: row.sessionHigh,
          belowHighPct: row.belowHighPct,
          volumeLead: row.volumeLead,
          spikeFalling: row.spikeFalling,
          askWall: wall.ask,
          bidWall: wall.bid,
          v2: row.v2,
          spark: row.spark,
          exists: true,
        });
      }
    }

    // Signal detection + broadcast.
    const fired = this.detectSignals(rows);
    if (fired.length > 0) {
      this.tracked.push(...fired);
      // Persist immediately so a reload never loses them.
      writeLocalSignals([...fired, ...readLocalSignals()].slice(0, LOCAL_SIGNALS_MAX));
      for (const s of fired) {
        this.listeners.onSignal?.(s);
        void postIngest({ mode: "new", signal: s });
      }
    }

    this.gradeShadow(this.lastPrices);
    this.gradeOutcomes(prices);
    this.flushOutcomes();
  }
}

// ── Singleton + React-friendly access ─────────────────────────────────────────

let engineSingleton: LocalRadarEngine | null = null;

export function getLocalRadar(): LocalRadarEngine {
  if (!engineSingleton) {
    engineSingleton = new LocalRadarEngine();
    // Console diagnostics: window.__siftRadar() shows the engine's internals
    // so connectivity issues can be debugged from devtools anywhere.
    if (typeof window !== "undefined") {
      (window as unknown as { __siftRadar?: () => unknown }).__siftRadar = () => engineSingleton?.debugState();
    }
  }
  return engineSingleton;
}

export function localRadarRunning(): boolean {
  return engineSingleton?.isRunning() ?? false;
}
