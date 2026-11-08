// Sift radar service — the always-on scanner.
//
// Rebuild of the original Sift Pump Radar with the reliability fixes that
// matter for capturing real opportunities:
//
//   1. It scans server-side every 5 seconds whether or not any browser is
//      open, so the signal log accumulates 24/7 instead of only while one
//      user keeps the tab focused.
//   2. One scanner serves every client over socket.io — N visitors cost the
//      Binance API the same as one, and nobody gets rate-limited.
//   3. Session state (highs, spikes) lives here, so reloads no longer reset
//      the dump detector.
//   4. Every signal is graded: 5/15/60 minutes later the scanner records what
//      the price actually did, plus running MFE/MAE, persisted via the Next.js
//      ingest webhook. Accountability instead of vibes.
//   5. Scoring adds a trade-count spike (filters one-whale-print volume) and
//      candle close strength on top of the original RVOL/momentum/buy-pressure
//      model.
//
// Data: Binance public market-data domain, no key. Polling, not websockets —
// 5-second granularity, honestly labeled as such.
//
// V2.1 audit pass (server side, feeding the rewritten v2-engine): exact-match
// junk blacklist, a 60-pair universe ranked by 24h-volume anomaly against a
// persisted 7-day history, a time-of-day/self-excluded volume baseline over a
// full 24h of candles, beta-adjusted residual momentum, CVD + trade-size
// skew, range-weighted close strength, walls scored relative to the book with
// persistence age, futures positioning (funding/OI/L-S), listing age, the
// uncapped score with ranked GO firing, a portfolio guard with a kill switch,
// regime resets of the cooldown ledger, and a hot/cold priority kline pump.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { Server, type Socket } from "socket.io";
import {
  CooldownLedger,
  PortfolioGuard,
  V2,
  assessRowWithSides,
  atrPctFromCandles,
  atrWindow,
  stablecoinLike,
  type BtcMode,
  type V2Wall,
} from "../../src/lib/market/v2-engine";
import {
  liveVerdictConfig,
  nextBtcRegime,
  nextVerdictState,
  overlayVerdictState,
  stabilityStats,
  verdictSortRank,
  type BtcRegimeState,
  type StabilityStats,
  type VerdictChangeEntry,
  type VerdictConfig,
  type VerdictState,
} from "../../src/lib/market/verdict-state";
import {
  anomalyScore,
  analyzeDepth,
  betaFromCloses,
  cvdSlope,
  isJunkBase,
  listingAgeDays,
  median,
  rankForSignalCut,
  sizeSpike,
  trackWallAge,
  volumeBaseline,
  type WallTrack,
} from "../../src/lib/market/baseline";
import type { BtcContext, RadarRowV2 } from "../../src/lib/market/types";

// ── Configuration ────────────────────────────────────────────────────────────

const PORT = 3003;
// The vision mirror first; api.binance.com as failover for network errors.
// 418/429 bans are per-IP and handled with hard, doubling backoff.
const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api4.binance.com"];
const SCAN_INTERVAL_MS = 3_000; // V2.2: the verdict tick (was 5s display-only cadence) — compute + emit, no network. Price snapshots still flow per-pair over socket rooms.
const UNIVERSE_LIMIT = 60; // §2.2 — anomaly-ranked universe (was 40 by absolute volume)
const UNIVERSE_REFRESH_MS = 5 * 60_000;
const KLINE_LIMIT = 288; // §2.3 — 24h of 1m candles (kline weight class barely moves: 1→2)
const STATS_REFRESH_MS = 30_000; // §7 — halved; change24h now comes from candles, this is belt-and-braces
// §2.2 universe liquidity gates — dust and one-print tapes never pump honestly.
const UNIVERSE_MIN_QUOTE_VOLUME = 2_000_000;
const UNIVERSE_MIN_TRADES_24H = 5_000;
// §4 futures positioning (fapi.binance.com — separate weight pool, no key).
const FUTURES_TICK_MS = 2_500;
const FUTURES_TTL_MS = 60_000;
const SIGNAL_COOLDOWN_MS = 10 * 60_000; // per pair+type
const MAX_SIGNALS_PER_SCAN = 6;
const OUTCOME_HORIZON_MS = 60 * 60_000;
// Adaptive pacing tiers, keyed on the last observed x-mbx-used-weight-1m.
// This sandbox shares an egress IP with other Binance traffic, so the
// scanner must watch the shared weight window and yield when it fills.
const WEIGHT_TIERS: Array<{ maxWeight: number; paceMs: number }> = [
  { maxWeight: 1_200, paceMs: 160 }, // fresh window — brisk
  { maxWeight: 2_500, paceMs: 450 }, // filling — normal
  { maxWeight: 4_000, paceMs: 1_400 }, // crowded — slow down
  { maxWeight: Number.POSITIVE_INFINITY, paceMs: 9_000 }, // nearly full — stand aside
];
const BAN_BACKOFF_INITIAL_MS = 5 * 60_000; // hard quiet after a 418, doubling
const BAN_BACKOFF_MAX_MS = 40 * 60_000;
const BAN_CLEAN_RESET_MS = 30 * 60_000; // clean operation resets the backoff
const INGEST_URL = process.env.SIFT_INGEST_URL ?? "http://127.0.0.1:3000/api/signals/ingest";
const INGEST_KEY = process.env.SIFT_INGEST_KEY ?? "sift-local-dev-key";
const PRUNE_INTERVAL_MS = 60 * 60_000;

// ── Types (mirrors of src/lib/market/types.ts — keep them in sync) ───────────

type RadarBadge = "pump" | "early" | "dumping" | "pumped";
type RadarSignal = "pumping" | "dumping" | "long" | "short" | "flat";

type RadarRow = {
  pair: string;
  base: string;
  price: number;
  change1m: number;
  change5m: number;
  change15m: number;
  change24h: number;
  volume24h: number;
  vol5mUsd: number;
  volAvg5mUsd: number;
  rvol: number;
  tradeSpike: number;
  trades5m: number;
  buyPct: number;
  closeStrength: number;
  score: number;
  sessionHigh: number;
  belowHighPct: number;
  badge: RadarBadge | null;
  volumeLead: boolean;
  spikeFalling: boolean;
  signal: RadarSignal;
  spark: number[];
  atrPct: number | null;
  // V2.1 feeds computed in toRow, consumed by assessRow (§2.3/§3.4/§4).
  beta?: number | null;
  residChange5m?: number | null;
  residChange15m?: number | null;
  cvdSlope15m?: number | null;
  avgTradeSizeSpike?: number | null;
  historyBlocks?: number | null;
  v2: RadarRowV2 | null;
};

type RadarSnapshot = {
  rows: RadarRow[];
  updatedAt: string;
  universe: number;
  clients: number;
  scans: number;
  stale: boolean;
  btc: BtcContext | null;
  stability?: StabilityStats | null; // V2.2 — verdict-layer churn metrics
};

type SignalType =
  | "pump_start"
  | "volume_lead"
  | "buyer_pressure"
  | "seller_pressure"
  | "dump_start"
  | "spike_collapse"
  | "go_long"
  | "go_short";

type TrackedSignal = {
  id: string;
  pair: string;
  base: string;
  type: SignalType;
  direction: "long" | "short";
  score: number;
  price: number;
  change24h: number;
  rvol: number;
  buyPct: number;
  volume24h: number;
  note: string | null;
  createdAt: number;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  atrPct: number | null;
  riskPct: number | null; // §5.2 — the plan's own risk %, to grade outcomes in R units
  // outcome tracking
  sentNew: boolean;
  sent5m: boolean;
  sent15m: boolean;
  sent60m: boolean;
  mfe: number; // direction-adjusted best excursion so far (pct)
  mae: number; // direction-adjusted worst excursion so far (pct)
  final: boolean;
};

// ── Small utilities ──────────────────────────────────────────────────────────

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Weight-aware Binance fetch with host failover. Every response carries
// x-mbx-used-weight-1m — the shared-IP window usage — which drives the
// adaptive pacing. A 418/429 answer sets a hard, doubling quiet period.
async function binanceFetch(path: string, timeoutMs = 10_000): Promise<unknown> {
  trackRequest();
  if (bannedUntil > Date.now()) throw new Error("banned");
  let lastError: unknown = null;
  for (let attempt = 0; attempt < HOSTS.length; attempt += 1) {
    const host = HOSTS[attempt];
    try {
      const response = await fetch(host + path, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const weight = Number(response.headers.get("x-mbx-used-weight-1m"));
      if (Number.isFinite(weight) && weight >= 0) lastUsedWeight = weight;
      if (response.status === 418 || response.status === 429) {
        bannedUntil = Date.now() + banBackoffMs;
        banBackoffMs = Math.min(BAN_BACKOFF_MAX_MS, banBackoffMs * 2);
        lastCleanAt = Date.now(); // the quiet period counts as clean time
        throw new Error(`Binance responded ${response.status} — backing off ${Math.round(banBackoffMs / 60000)}min`);
      }
      if (!response.ok) throw new Error(`Binance responded ${response.status}`);
      const data = (await response.json()) as unknown;
      if (Date.now() - lastCleanAt > BAN_CLEAN_RESET_MS) banBackoffMs = BAN_BACKOFF_INITIAL_MS;
      lastCleanAt = Date.now();
      return data;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.startsWith("Binance responded 4")) throw error;
      // Network errors/timeouts: try the next host.
    }
  }
  throw lastError ?? new Error("Binance unreachable");
}

// ── Universe filtering (junk that never pumps) ───────────────────────────────
// §2.1: the blacklist lives in baseline.ts (isJunkBase) — EXACT matches only.
// The old suffix heuristics here silently killed JUP, BNB, SHIB, ARB, CKB…
// while catching exactly zero real leveraged tokens (those are delisted).

// ── Scanner state ────────────────────────────────────────────────────────────

type Ticker24h = {
  symbol?: unknown;
  lastPrice?: unknown;
  quoteVolume?: unknown;
  priceChangePercent?: unknown;
  count?: unknown; // trades in the last 24h — the §2.2 universe gate
};

// Binance kline: [openTime, open, high, low, close, volume, closeTime,
// quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
type Kline = [number, string, string, string, string, string, number, string, number, string, string, string];

let universe: string[] = [];
let universeUpdatedAt = 0;
// Live data stores — filled by the paced background tasks, read by the scan.
const candles = new Map<string, Kline[]>(); // pair → last hour of 1m candles
const stats = new Map<string, Ticker24h>(); // pair → 24h ticker stats
let statsUpdatedAt = 0;

const sessionHighs = new Map<string, number>();
const lastRvol = new Map<string, number>();

const trackedSignals: TrackedSignal[] = []; // newest last
const cooldowns = new Map<string, number>(); // `${pair}:${type}` → last fired ms

const pairRooms = new Map<string, Set<string>>(); // pair → socket ids
const pairMissing = new Map<string, number>(); // pair → last time we verified it doesn't exist
// §2.5/§3.2/§4 — the book relative to ITSELF: the wall vs the band depth it
// sits in, the top-of-book spread, and the ask runway to TP2 — not just the
// biggest single level in a ±2% band.
type Walls = {
  at: number;
  ask: { price: number; valueUsd: number } | null;
  bid: { price: number; valueUsd: number } | null;
  spreadBps: number | null;
  askDepthUsd: number; // asks up to +7% — the TP2 exit runway
  askWallToDepth: number | null; // biggest ask / total asks in the scan band (0..1)
  bidWallToDepth: number | null;
};
const wallCache = new Map<string, Walls>();
// §4 wall persistence — a wall that appeared seconds ago is probably spoofed;
// age is what separates a real level from paint.
const wallTracks = new Map<string, WallTrack>();
const wallBreaks = new Map<string, { wallPrice: number; aboveSince: number | null }>();
// Candidates worth spending depth requests on — refreshed every scan.
let wallCandidates: string[] = [];
const ledger = new CooldownLedger();
// §10: a BTC regime flip voids directional blocks earned in the old regime.
let lastBtcMode: BtcMode | null = null;
// ── V2.2 — the stateful verdict layer (audit Part B) ────────────────────────
// Per-pair, per-side verdict states + the dwelled BTC regime + the change log
// that measures whether the stability layer is actually working.
const verdictLongStates = new Map<string, VerdictState>();
const verdictShortStates = new Map<string, VerdictState>();
let btcRegime: BtcRegimeState | null = null;
const verdictChangeLog: VerdictChangeEntry[] = []; // newest first, bounded
const VERDICT_CHANGE_LOG_MAX = 300;
const liveCfg: VerdictConfig = liveVerdictConfig();
// Kline freshness per pair — the verdict's data-age freeze reads this.
const candleAt = new Map<string, number>();
// Wall-absence confirmation clocks (per side): "+8 no wall" only after 30 s.
const askAbsentSince = new Map<string, number>();
const bidAbsentSince = new Map<string, number>();
// §4 futures positioning cache (funding / OI / L-S ratio), 60s TTL, paced fill.
type FuturesData = { at: number; funding: number | null; oi: number | null; ls: number | null };
const futuresCache = new Map<string, FuturesData>();
// §4 listing age — days since the pair's first Binance daily candle.
const listingAge = new Map<string, number>();
// §5.2 portfolio guard — one book, not N independent bets.
const guard = new PortfolioGuard();
const guardWarnAt = new Map<string, number>(); // pair → last guard warn (10-min damper)
// §5.4 diagnostics — size of the hot kline rotation, exposed on /health.
let hotPairCount = 0;
let btcContext: BtcContext | null = null;

let lastSnapshot: RadarSnapshot | null = null;
let scans = 0;
let consecutiveFailures = 0;
let bannedUntil = 0; // Binance 418/429 hard backoff
let banBackoffMs = BAN_BACKOFF_INITIAL_MS;
let lastCleanAt = Date.now(); // for resetting the ban backoff after quiet operation
let lastUsedWeight = 0; // last observed shared-IP weight window usage
let requestTimestamps: number[] = []; // outgoing requests, for /health diagnostics

// Hot-reload generation guard: `bun --hot` re-runs this module on edits while
// old timers may still fire. Each module load gets a generation number; any
// callback from an older generation stands down immediately.
const g0 = globalThis as unknown as { __siftRadarGen?: number };
const GENERATION = (g0.__siftRadarGen ?? 0) + 1;
g0.__siftRadarGen = GENERATION;
function isCurrentGeneration(): boolean {
  return (globalThis as unknown as { __siftRadarGen?: number }).__siftRadarGen === GENERATION;
}

function trackRequest() {
  const now = Date.now();
  requestTimestamps.push(now);
  requestTimestamps = requestTimestamps.filter((t) => now - t < 60_000);
}

// ── Persistence (audit §2.2 / §4) ─────────────────────────────────────────────
//
// Two tiny JSON files under mini-services/radar/data/: the 24h-quoteVolume
// history that powers anomaly-based universe ranking, and listing ages. Both
// are best-effort — a failed write only degrades ranking to absolute volume,
// never the scan itself.

const DATA_DIR = fileURLToPath(new URL("./data", import.meta.url));
const VOL_HISTORY_PATH = `${DATA_DIR}/vol-history.json`;
const LISTING_AGE_PATH = `${DATA_DIR}/listing-age.json`;
const VOL_SNAPSHOT_MIN_MS = 3 * 60 * 60_000; // one sample per 3h → 56 samples ≈ 7 days
const VOL_HISTORY_MAX_SAMPLES = 56;
const VOL_HISTORY_MAX_PAIRS = 400;

const volHistory = new Map<string, number[]>(); // pair → 24h quoteVolume samples
let volHistorySnapAt = 0;

function loadJsonMap(path: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) out.set(key, value);
    }
  } catch {
    /* absent or corrupt — first boot simply ranks by absolute volume */
  }
  return out;
}

function persistJsonMap(path: string, entries: Iterable<[string, unknown]>): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)));
    renameSync(tmp, path); // atomic-ish: readers see old or new, never half
  } catch {
    /* best-effort only */
  }
}

function loadVolHistory(): void {
  for (const [pair, samples] of loadJsonMap(VOL_HISTORY_PATH)) {
    if (!Array.isArray(samples)) continue;
    const clean = samples
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
      .slice(-VOL_HISTORY_MAX_SAMPLES);
    if (clean.length > 0) volHistory.set(pair, clean);
  }
}

function persistVolHistory(): void {
  persistJsonMap(VOL_HISTORY_PATH, volHistory.entries());
}

function loadListingAge(): void {
  for (const [pair, age] of loadJsonMap(LISTING_AGE_PATH)) {
    if (typeof age === "number" && Number.isFinite(age) && age >= 0) listingAge.set(pair, age);
  }
}

function persistListingAge(): void {
  persistJsonMap(LISTING_AGE_PATH, listingAge.entries());
}

// §2.2: one 24h-quoteVolume sample per pair every 3h (56 samples ≈ 7 days),
// top ~400 pairs by volume, persisted best-effort — this is the history the
// anomaly ranking measures "money arriving HERE, now" against.
function snapshotVolHistory(rows: Ticker24h[]): void {
  const now = Date.now();
  if (now - volHistorySnapAt < VOL_SNAPSHOT_MIN_MS) return;
  volHistorySnapAt = now;
  const top = [...rows].sort((a, b) => num(b.quoteVolume) - num(a.quoteVolume)).slice(0, VOL_HISTORY_MAX_PAIRS);
  const keep = new Set<string>();
  for (const row of top) {
    const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : "";
    const qv = num(row.quoteVolume);
    if (!symbol || qv <= 0) continue;
    keep.add(symbol);
    const samples = volHistory.get(symbol) ?? [];
    samples.push(qv);
    volHistory.set(symbol, samples.slice(-VOL_HISTORY_MAX_SAMPLES));
  }
  // Churn control: pairs that fell out of the top-400 long ago stop accruing.
  if (volHistory.size > VOL_HISTORY_MAX_PAIRS * 2) {
    for (const pair of volHistory.keys()) {
      if (!keep.has(pair)) volHistory.delete(pair);
    }
  }
  persistVolHistory();
}

mkdirSync(DATA_DIR, { recursive: true });
loadVolHistory();
loadListingAge();

// ── Servers ─────────────────────────────────────────────────────────────────

// Port 3003 — socket.io for browsers, path MUST stay "/" (gateway rule).
// engine.io with path "/" intercepts every HTTP request on its server, so
// REST endpoints cannot share this port.
const httpServer = createServer();

const io = new Server(httpServer, {
  // DO NOT change the path — the sandbox gateway forwards on it.
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60_000,
  pingInterval: 25_000,
});

// Port 3004 — internal REST for the Next.js proxy (server-side only, never
// exposed through the gateway). Serves the same snapshot the socket pushes
// so the app still works if a browser cannot hold a websocket.
const INTERNAL_PORT = 3004;
const restServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const route = (req.url ?? "").split("?")[0];
  if (req.method === "GET" && route === "/snapshot") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(snapshotForClients()));
    return;
  }
  if (req.method === "GET" && route === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        scans,
        universe: universe.length,
        signals: trackedSignals.length,
        clients: io.engine.clientsCount,
        requestsPerMinute: requestTimestamps.length,
        usedWeight: lastUsedWeight,
        paceMs: pumpPaceMs(),
        candles: candles.size,
        futures: futuresCache.size, // §4 — pairs with cached funding/OI/L-S data
        hotPairs: hotPairCount, // §5.4 — current hot kline rotation size
        statsAgeSec: statsUpdatedAt > 0 ? Math.round((Date.now() - statsUpdatedAt) / 1000) : null,
        bannedFor: Math.max(0, bannedUntil - Date.now()),
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

io.on("connection", (socket: Socket) => {
  socket.emit("radar:snapshot", snapshotForClients());
  socket.emit("signals:recent", recentSignalsPayload());

  socket.on("pair:subscribe", (data: { pair?: unknown }) => {
    const pair = typeof data?.pair === "string" ? data.pair.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    if (!pair || pair.length < 5 || pair.length > 16) return;
    let ids = pairRooms.get(pair);
    if (!ids) {
      ids = new Set();
      pairRooms.set(pair, ids);
    }
    ids.add(socket.id);
    socket.join(`pair:${pair}`);
    // If the pair is already scanned, send an immediate update.
    const row = lastSnapshot?.rows.find((r) => r.pair === pair);
    if (row) void emitPairUpdate(row);
    else void emitMissingPairUpdate(pair);
  });

  socket.on("pair:unsubscribe", (data: { pair?: unknown }) => {
    const pair = typeof data?.pair === "string" ? data.pair.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    if (!pair) return;
    const ids = pairRooms.get(pair);
    if (ids) {
      ids.delete(socket.id);
      if (ids.size === 0) {
        pairRooms.delete(pair);
        wallCache.delete(pair);
      }
    }
    socket.leave(`pair:${pair}`);
  });

  socket.on("disconnect", () => {
    for (const [pair, ids] of pairRooms) {
      ids.delete(socket.id);
      if (ids.size === 0) {
        pairRooms.delete(pair);
        wallCache.delete(pair);
      }
    }
  });
});

function snapshotForClients(): RadarSnapshot {
  if (lastSnapshot) {
    return { ...lastSnapshot, clients: io.engine.clientsCount, stale: consecutiveFailures > 0, btc: btcContext };
  }
  return {
    rows: [],
    updatedAt: new Date().toISOString(),
    universe: universe.length,
    clients: io.engine.clientsCount,
    scans,
    stale: false,
    btc: btcContext,
  };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

// Opportunity score, 0–100 — improved from the original three-factor model:
//   RVOL spike      up to 30 pts (1× → 0, 5×+ → 30)
//   Trade spike     up to 10 pts — a volume spike without a trade spike is
//                   one whale print, not a crowd. This filters it.
//   Momentum        up to 25 pts (all three timeframes green +10, 5m ≥ 15m
//                   acceleration +8, 1m ≥ 5m still-accelerating +7)
//   Buy pressure    up to 20 pts (taker-buy share, 50% → 0, 80%+ → 20)
//   Close strength  up to 15 pts — closes near candle highs mean buyers are
//                   paying up into strength, not fading it.
// §10: the composite is UNCAPPED internally (the bounded components keep it
// ~0–100 in practice) — ranking consumers must never see a clipped value;
// only the display caps at 100.
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
  // §2.5/§10: uncapped, floored at 0 — never Math.min(100, …).
  return Math.round(Math.max(0, rvolPts + tradePts + momentumPts + buyPts + closePts));
}

function badgeFor(score: number, rvol: number, change24h: number, belowHighPct: number): RadarBadge | null {
  if (change24h > 8) return "pumped";
  if (score >= 80) return "pump";
  if (belowHighPct >= 3) return "dumping";
  if (rvol >= 3 && change24h >= -5 && change24h <= 8) return "early";
  return null;
}

function decideSignal(row: RadarRow): RadarSignal {
  if (row.change24h <= 8 && row.score >= 80 && row.change5m > 0) return "pumping";
  if (row.badge === "dumping" && row.rvol >= 2 && row.change5m < 0) return "dumping";
  const flatDay = row.change24h >= -5 && row.change24h <= 8;
  const flatNow = Math.abs(row.change1m) <= 1 && Math.abs(row.change5m) <= 1;
  if (flatDay && flatNow && row.rvol >= 2 && row.buyPct >= 70) return "long";
  if (flatDay && flatNow && row.rvol >= 2 && row.buyPct <= 30) return "short";
  return "flat";
}

// ── Row construction from a ticker + klines ──────────────────────────────────

// §3.4: BTC context for beta/residual math — scan() builds BTC's row first
// and hands its closes and own 5m/15m moves to every other row. BTC itself
// gets nulls (its residual vs itself is zero by construction, so the engine
// scores its raw move).
type BtcRowContext = { closes: number[] | null; change5m: number | null; change15m: number | null };

function toRow(ticker: Ticker24h, klines: Kline[], btc: BtcRowContext): RadarRow | null {
  const pair = typeof ticker.symbol === "string" ? ticker.symbol.toUpperCase() : "";
  if (!pair || !pair.endsWith("USDT") || klines.length < 16) return null;
  const closes = klines.map((k) => num(k[4]));
  const quotes = klines.map((k) => num(k[7]));
  const trades = klines.map((k) => num(k[8]));
  const takerBuys = klines.map((k) => num(k[10]));
  const last = closes.length - 1;

  const move = (from: number, to: number) => {
    const start = closes[from] ?? 0;
    const end = closes[to] ?? 0;
    return start === 0 ? 0 : ((end - start) / start) * 100;
  };
  const change1m = move(last - 1, last);
  const change5m = move(last - 5, last);
  const change15m = move(last - 15, last);

  const vol5m = quotes.slice(-5).reduce((a, b) => a + b, 0);
  const trades5m = trades.slice(-5).reduce((a, b) => a + b, 0);

  // §2.3: 5m blocks over the FULL 24h candle window, bucketed by open time.
  // volumeBaseline() then picks the time-of-day median with the last 30 min
  // self-excluded — the spike never dilutes its own baseline and 4am quiet
  // no longer reads as an anomaly. The old mean-over-prior-hour baseline did
  // both.
  const blockAgg = new Map<number, { qv: number; trades: number }>();
  for (const k of klines) {
    const t = Math.floor(num(k[0]) / 300_000) * 300_000;
    const block = blockAgg.get(t) ?? { qv: 0, trades: 0 };
    block.qv += num(k[7]);
    block.trades += num(k[8]);
    blockAgg.set(t, block);
  }
  const blocks = [...blockAgg.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, block]) => ({ t, qv: block.qv, trades: block.trades }));
  const volumeBase = volumeBaseline(blocks, 6, 6);
  const volAvg5m = volumeBase.baseline; // field name kept for payload compat
  const historyBlocks = volumeBase.blocks; // ≥20 usable blocks = trustworthy rvol
  const rvol = volAvg5m > 0 ? vol5m / volAvg5m : 0;
  // tradeSpike baseline: MEDIAN trades per usable 5m block (same window),
  // floored at 1 so a dead tape can't manufacture an infinite spike.
  const tradeBase5m = Math.max(1, median(blocks.slice(0, Math.max(0, blocks.length - 6)).map((b) => b.trades)));
  const tradeSpike = trades5m / tradeBase5m;

  const buyQuote5m = takerBuys.slice(-5).reduce((a, b) => a + b, 0);
  const buyPct = vol5m > 0 ? (buyQuote5m / vol5m) * 100 : 50;

  const price = closes.length > 0 ? closes[closes.length - 1] ?? 0 : num(ticker.lastPrice);
  if (price <= 0) return null;

  // §2.2/§7: the 24h change from the candles themselves — the ticker's
  // priceChangePercent lags up to a full stats cycle and drifts from the tape
  // the engine actually scores. Fallback (< ~287 bars, i.e. a new listing):
  // the ticker value, documented and honest.
  const firstOpen = num(klines[0]?.[1]);
  const change24h =
    klines.length >= 287 && firstOpen > 0 ? ((price - firstOpen) / firstOpen) * 100 : num(ticker.priceChangePercent);

  // §2.6: the 24h kline window IS the session — the high is restart-proof and
  // can no longer depend on process uptime. The map stays only as a
  // diagnostic mirror, never larger than the candle window.
  const sessionHigh = Math.max(...klines.map((k) => num(k[2])), price);
  sessionHighs.set(pair, sessionHigh);
  const belowHighPct = sessionHigh > 0 ? ((sessionHigh - price) / sessionHigh) * 100 : 0;

  const volumeLead = rvol >= 3 && Math.abs(change5m) <= 1 && Math.abs(change1m) <= 1;
  const prevRvol = lastRvol.get(pair) ?? null;
  lastRvol.set(pair, rvol);
  const spikeFalling = prevRvol !== null && prevRvol >= 3 && rvol < 1.5;

  // ATR FIRST (§4) — the range weights below and the V2 stop both consume it.
  const atrPct = atrPctFromCandles(
    klines.map((k) => ({ high: num(k[2]), low: num(k[3]), close: num(k[4]) })),
    14,
  );

  // The trailing kline is the still-forming minute — closed-bar statistics
  // (close strength, CVD, trade sizes) must exclude it or the partial minute
  // quietly dilutes every baseline.
  const lastBar = klines[klines.length - 1];
  const closedBars = lastBar !== undefined && lastBar[6] > Date.now() ? klines.slice(0, -1) : klines;

  // §4 range-weighted close strength: a tight doji contributes almost
  // nothing, a wide impulse candle counts fully.
  let strengthSum = 0;
  let strengthCount = 0;
  for (const k of closedBars.slice(-5)) {
    const high = num(k[2]);
    const low = num(k[3]);
    const close = num(k[4]);
    const raw = high > low ? (close - low) / (high - low) : 0.5;
    const rangePct = close > 0 ? ((high - low) / close) * 100 : 0;
    const weight = atrPct !== null && atrPct > 0 ? Math.min(1, rangePct / (2 * atrPct)) : 0.5;
    strengthSum += 0.5 + (raw - 0.5) * weight;
    strengthCount += 1;
  }
  const closeStrength = strengthCount > 0 ? strengthSum / strengthCount : 0.5;

  // §4 CVD slope over the last 15 closed bars: Σ(takerBuy − takerSell) / Σvol.
  const cvdSlope15m = cvdSlope(
    closedBars.slice(-15).map((k) => ({ qv: num(k[7]), tb: num(k[10]) })),
    15,
  );

  // §4 trade-size skew: avg USD/trade over the last 5 closed bars vs the
  // median per-bar size of the prior 60 (bars with 0 trades skipped).
  const lastBars = closedBars.slice(-5);
  const sizeVol = lastBars.reduce((a, k) => a + num(k[7]), 0);
  const sizeCount = lastBars.reduce((a, k) => a + num(k[8]), 0);
  const priorSizes: number[] = [];
  for (const k of closedBars.slice(-65, -5)) {
    const t = num(k[8]);
    if (t > 0) priorSizes.push(num(k[7]) / t);
  }
  const avgTradeSizeSpike =
    sizeCount > 0 ? sizeSpike(sizeVol / sizeCount, priorSizes.length > 0 ? median(priorSizes) : 0) : null;

  // §3.4 beta + residual momentum — the engine stops rewarding plain beta.
  const beta = btc.closes !== null ? betaFromCloses(closes.slice(-60), btc.closes, 40) : null;
  const residChange5m = beta !== null && btc.change5m !== null ? change5m - beta * btc.change5m : null;
  const residChange15m = beta !== null && btc.change15m !== null ? change15m - beta * btc.change15m : null;

  const score = pumpScore(rvol, tradeSpike, change1m, change5m, change15m, buyPct, closeStrength);
  const badge = badgeFor(score, rvol, change24h, belowHighPct);

  const row: RadarRow = {
    pair,
    base: pair.slice(0, -4),
    price,
    change1m,
    change5m,
    change15m,
    change24h,
    volume24h: num(ticker.quoteVolume),
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
    badge,
    volumeLead,
    spikeFalling,
    signal: "flat",
    spark: closes.slice(-60),
    atrPct,
    beta,
    residChange5m,
    residChange15m,
    cvdSlope15m,
    avgTradeSizeSpike,
    historyBlocks,
    v2: null,
  };
  row.signal = decideSignal(row);
  return row;
}

// ── Data acquisition — three paced background tasks ─────────────────────────
//
// The old design fired ~60 requests in a burst every 5 seconds; on this
// sandbox's shared egress IP that bursts straight into Binance's rate-limit
// ban. The replacement paces requests one at a time, adapts the pace to the
// shared weight window reported by every response, and splits concerns:
//
//   • klinePump — one pair's candles per pace-tick, rotating through the
//     universe + subscribed extras. No bursts, ever.
//   • statsTask — batched 24h ticker stats once a minute (weight-cheap).
//   • universeTask — full ticker every 5 minutes to re-rank the universe.
//
// The scan itself becomes pure computation over the stores: zero network.

async function refreshUniverse(): Promise<void> {
  const payload = await binanceFetch("/api/v3/ticker/24hr", 20_000);
  if (!Array.isArray(payload)) throw new Error("Unexpected Binance payload");
  // §2.1: exact-match junk filter from baseline.ts — the old suffix
  // heuristics silently killed JUP, BNB, SHIB, ARB…
  const usdtRows: Ticker24h[] = [];
  for (const row of payload as Ticker24h[]) {
    const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : "";
    if (!symbol.endsWith("USDT")) continue;
    const base = symbol.slice(0, -4);
    if (!base || isJunkBase(base)) continue;
    usdtRows.push(row);
  }
  // §2.2 candidates: liquidity-gated (≥$2M 24h quote volume AND ≥5k trades)…
  const candidates = usdtRows
    .filter((row) => num(row.quoteVolume) >= UNIVERSE_MIN_QUOTE_VOLUME && num(row.count) >= UNIVERSE_MIN_TRADES_24H)
    .map((row) => {
      const symbol = String(row.symbol).toUpperCase();
      return { symbol, qv: num(row.quoteVolume), history: volHistory.get(symbol) ?? [] };
    });
  // …ranked by volume ANOMALY vs the persisted 7-day history — money arriving
  // HERE, now, which absolute volume never found. Pairs with <2 history
  // samples rank after, by absolute volume: big-and-quiet beats unknown. The
  // snapshot is taken AFTER ranking so history stays "current vs PAST".
  const ranked = candidates
    .filter((c) => c.history.length >= 2)
    .sort((a, b) => anomalyScore(b.qv, b.history) - anomalyScore(a.qv, a.history) || b.qv - a.qv);
  const unranked = candidates.filter((c) => c.history.length < 2).sort((a, b) => b.qv - a.qv);
  const selected = new Set([...ranked, ...unranked].slice(0, UNIVERSE_LIMIT).map((c) => c.symbol));
  snapshotVolHistory(usdtRows);
  const nextUniverse: string[] = [];
  const nextStats = new Map<string, Ticker24h>();
  for (const row of usdtRows) {
    const symbol = String(row.symbol).toUpperCase();
    if (!selected.has(symbol)) continue;
    nextUniverse.push(symbol);
    nextStats.set(symbol, row);
  }
  // BTC and ETH always ride along — the V2 market-regime filter reads BTC's
  // own 15m tape every scan, and ETH is the liquidity bellwether.
  for (const anchor of ["BTCUSDT", "ETHUSDT"]) {
    if (nextUniverse.includes(anchor)) continue;
    try {
      const t = (await binanceFetch(`/api/v3/ticker/24hr?symbol=${anchor}`, 8_000)) as Ticker24h;
      if (typeof t.symbol === "string") {
        nextUniverse.push(anchor);
        nextStats.set(anchor, t);
      }
    } catch {
      /* anchor stays absent this round — retry in 5 minutes */
    }
  }
  universe = nextUniverse;
  statsUpdatedAt = Date.now();
  // Merge: keep stats for subscribed extras, replace universe stats.
  const merged = new Map<string, Ticker24h>();
  for (const [pair, row] of nextStats) merged.set(pair, row);
  for (const [pair, row] of stats) if (!merged.has(pair)) merged.set(pair, row);
  stats.clear();
  for (const [pair, row] of merged) stats.set(pair, row);
  universeUpdatedAt = Date.now();
  // Drop state for pairs that left the universe (keep subscribed extras).
  const keep = new Set([...nextUniverse, ...pairRooms.keys()]);
  for (const pair of candles.keys()) {
    if (!keep.has(pair)) {
      candles.delete(pair);
      sessionHighs.delete(pair);
      lastRvol.delete(pair);
      wallTracks.delete(pair);
      futuresCache.delete(pair);
    }
  }
  // §4 listing age: one paced daily-kline fetch (startTime=0 → the pair's
  // FIRST candle) per pair on universe entry — new listings have meaningless
  // baselines and the engine gates on exactly that.
  let ageAdded = false;
  for (const pair of nextUniverse) {
    if (listingAge.has(pair)) continue;
    if (bannedUntil > Date.now()) break;
    try {
      const daily = await binanceFetch(`/api/v3/klines?symbol=${pair}&interval=1d&limit=1&startTime=0`, 10_000);
      if (Array.isArray(daily)) {
        const firstOpenMs = num((daily as Kline[])[0]?.[0]);
        const age = listingAgeDays(firstOpenMs > 0 ? firstOpenMs : null);
        if (age !== null) {
          listingAge.set(pair, age);
          ageAdded = true;
        }
      }
    } catch {
      /* absent pair or network hiccup — retried on the next refresh */
    }
    await sleep(pumpPaceMs());
  }
  if (ageAdded) persistListingAge();
}

function pumpPaceMs(): number {
  for (const tier of WEIGHT_TIERS) {
    if (lastUsedWeight < tier.maxWeight) return tier.paceMs;
  }
  return WEIGHT_TIERS[WEIGHT_TIERS.length - 1]?.paceMs ?? 500;
}

async function klinePumpLoop(): Promise<void> {
  let hotCursor = 0;
  let coldCursor = 0;
  let tick = 0;
  const failureStreaks = new Map<string, number>();
  while (!stopped && isCurrentGeneration()) {
    await sleep(pumpPaceMs());
    if (bannedUntil > Date.now()) continue;
    // §5.4 hot/cold split, recomputed from the last snapshot every tick: hot =
    // watch-score / ≥2× rvol / subscribed — the money is moving THERE, so hot
    // candles refresh on (almost) every rotation tick while the cold tail is
    // served only every 3rd. Same one-request-per-tick budget; the freshness
    // goes where it counts.
    const rowByPair = new Map<string, RadarRow>();
    if (lastSnapshot) for (const r of lastSnapshot.rows) rowByPair.set(r.pair, r);
    const hot: string[] = [];
    const cold: string[] = [];
    for (const pair of universe) {
      const row = rowByPair.get(pair);
      if (pairRooms.has(pair) || (row !== undefined && (row.score >= V2.watchScore || row.rvol >= 2))) hot.push(pair);
      else cold.push(pair);
    }
    for (const extra of pairRooms.keys()) {
      if (!universe.includes(extra)) hot.push(extra); // subscribed extras are always hot
    }
    hotPairCount = hot.length;
    tick += 1;
    // Cold is served on every 3rd tick — or always while no hot rotation
    // exists, because an idle pump wastes the budget it was granted.
    const serveCold = cold.length > 0 && (tick % 3 === 0 || hot.length === 0);
    let pair: string | undefined;
    if (serveCold) {
      pair = cold[coldCursor % cold.length];
      coldCursor += 1;
    } else if (hot.length > 0) {
      pair = hot[hotCursor % hot.length];
      hotCursor += 1;
    }
    if (!pair) continue;
    try {
      const payload = await binanceFetch(
        `/api/v3/klines?symbol=${pair}&interval=1m&limit=${KLINE_LIMIT}`,
        10_000,
      );
      if (Array.isArray(payload) && (payload as Kline[]).length >= 16) {
        candles.set(pair, payload as Kline[]);
        candleAt.set(pair, Date.now()); // V2.2 — verdict data-age clock
        failureStreaks.set(pair, 0);
        pairMissing.delete(pair);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "Binance responded 400/404" means the pair genuinely doesn't exist —
      // tell the coin sheet honestly instead of retrying forever.
      if (/responded 4(00|04)/.test(message)) {
        const streak = (failureStreaks.get(pair) ?? 0) + 1;
        failureStreaks.set(pair, streak);
        if (streak >= 2 && pairRooms.has(pair)) {
          const last = pairMissing.get(pair) ?? 0;
          if (Date.now() - last > 60_000) {
            pairMissing.set(pair, Date.now());
            await emitMissingPairUpdate(pair);
          }
        }
      }
      // Bans/network errors: the pace + backoff logic handles recovery.
    }
  }
}

async function statsTaskLoop(): Promise<void> {
  while (!stopped && isCurrentGeneration()) {
    await sleep(STATS_REFRESH_MS);
    if (bannedUntil > Date.now()) continue;
    if (universe.length === 0) continue;
    try {
      // Batched 24h stats for the universe — one request, all pairs.
      const symbols = JSON.stringify(universe);
      const payload = await binanceFetch(
        `/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbols)}`,
        12_000,
      );
      if (Array.isArray(payload)) {
        for (const row of payload as Ticker24h[]) {
          const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : "";
          if (symbol) stats.set(symbol, row);
        }
        statsUpdatedAt = Date.now();
      }
    } catch {
      /* batch failed — stats stay stale, scan keeps running on candles */
    }
    // Subscribed extras get their stats one by one (they are few).
    for (const pair of pairRooms.keys()) {
      if (universe.includes(pair)) continue;
      if (bannedUntil > Date.now()) break;
      try {
        const payload = (await binanceFetch(`/api/v3/ticker/24hr?symbol=${pair}`, 8_000)) as Ticker24h;
        if (typeof payload.symbol === "string") stats.set(pair, payload);
      } catch {
        /* reported as missing by the pump when the symbol is invalid */
      }
    }
  }
}

async function universeTaskLoop(): Promise<void> {
  while (!stopped && isCurrentGeneration()) {
    await sleep(UNIVERSE_REFRESH_MS);
    if (bannedUntil > Date.now()) continue;
    try {
      await refreshUniverse();
    } catch {
      /* keep the previous universe */
    }
  }
}

// ── Order book walls (candidates + subscribed pairs) ─────────────────────

const WALL_TTL_MS = 25_000; // refresh cadence target
const WALL_KNOWN_MS = 75_000; // older than this → "no data" again
const WALL_CANDIDATE_MIN_SCORE = 50;
const WALL_CANDIDATE_LIMIT = 12;

async function fetchWalls(pair: string, price: number): Promise<Walls | null> {
  if (price <= 0) return null;
  try {
    // §2.5/§3.2/§4: 100 levels through analyzeDepth — the wall vs the book it
    // sits in (wallToDepth), the top-of-book spread, and the ask runway to
    // TP2, instead of just the biggest level in a ±2% band.
    const payload = (await binanceFetch(`/api/v3/depth?symbol=${pair}&limit=100`, 8_000)) as {
      asks?: Array<[string, string]>;
      bids?: Array<[string, string]>;
    };
    const asks = Array.isArray(payload.asks) ? payload.asks : [];
    const bids = Array.isArray(payload.bids) ? payload.bids : [];
    const depth = analyzeDepth(asks, bids, price, V2.wallScanPct);
    const walls: Walls = {
      at: Date.now(),
      ask: depth.askWall,
      bid: depth.bidWall,
      spreadBps: depth.spreadBps,
      askDepthUsd: depth.askDepthUsd,
      askWallToDepth: depth.askWallToDepth,
      bidWallToDepth: depth.bidWallToDepth,
    };
    wallCache.set(pair, walls);
    return walls;
  } catch {
    // Feed failed — keep whatever we had, marked stale, and retry soon.
    return null;
  }
}

function knownWalls(pair: string): { ask: V2Wall; bid: V2Wall; known: boolean } {
  const cached = wallCache.get(pair);
  if (!cached || Date.now() - cached.at > WALL_KNOWN_MS) return { ask: null, bid: null, known: false };
  return { ask: cached.ask, bid: cached.bid, known: true };
}

/** V2.2 — wall-absence confirmation: how long has the book shown NO wall in
 *  the scan band on this side? A pulled-and-republished wall can no longer
 *  oscillate the score — the "+8 runway" accrues only after 30 s of
 *  continuous, fresh absence. */
function trackWallAbsence(map: Map<string, number>, pair: string, known: boolean, wall: V2Wall, nowMs: number): number | null {
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

// "Wall broken — confirmed": price must hold above the wall for 2 minutes.
// Evaluated every scan against the latest cached wall; a moved wall resets it.
function wallBreakState(pair: string, price: number, ask: V2Wall): boolean | null {
  if (ask === null) return null; // no wall → nothing to break
  let track = wallBreaks.get(pair);
  if (!track || Math.abs(track.wallPrice - ask.price) / ask.price > 0.001) {
    track = { wallPrice: ask.price, aboveSince: null };
    wallBreaks.set(pair, track);
  }
  if (price > ask.price) {
    if (track.aboveSince === null) track.aboveSince = Date.now();
    return Date.now() - track.aboveSince >= V2.wallConfirmMs;
  }
  track.aboveSince = null;
  return false;
}

// Paced background task: rotates depth requests through the current
// candidates (top-scoring rows + subscribed pairs), one pair per tick, so the
// order-book spend stays tiny and nothing bursts.
async function wallPumpLoop(): Promise<void> {
  let cursor = 0;
  while (!stopped && isCurrentGeneration()) {
    await sleep(2_500);
    if (bannedUntil > Date.now()) continue;
    const rotation = [...new Set([...wallCandidates, ...pairRooms.keys()])];
    if (rotation.length === 0) continue;
    const pair = rotation[cursor % rotation.length];
    cursor += 1;
    if (!pair) continue;
    const cached = wallCache.get(pair);
    if (cached && Date.now() - cached.at < WALL_TTL_MS) continue; // fresh enough
    const row = lastSnapshot?.rows.find((r) => r.pair === pair);
    const price = row?.price ?? 0;
    if (price <= 0) continue;
    await fetchWalls(pair, price);
  }
}

// ── Futures positioning (audit §4) ───────────────────────────────────────────
//
// fapi.binance.com public endpoints, no key, separate weight pool from the
// spot hosts. One pair per ~2.5s tick over the current wall candidates (+
// subscribed pairs) with a 60s TTL: funding, the 15m open-interest change and
// the global long/short account ratio. Failures set nulls silently — the
// engine's filter just reports "no data" for that field.

async function futuresFetch(path: string): Promise<unknown | null> {
  try {
    const response = await fetch(`https://fapi.binance.com${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function numOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function refreshFutures(pair: string): Promise<void> {
  // Premium index → funding. 0 is a REAL value (neutral funding), so the
  // field is only null when the fetch or the shape failed.
  let funding: number | null = null;
  const premium = await futuresFetch(`/fapi/v1/premiumIndex?symbol=${pair}`);
  if (premium !== null && typeof premium === "object") {
    const rate = numOrNull((premium as { lastFundingRate?: unknown }).lastFundingRate);
    funding = rate !== null ? rate * 100 : null;
  }
  // OI history (5m × 4 buckets) → 15m open-interest change, %.
  let oi: number | null = null;
  const oiHist = await futuresFetch(`/futures/data/openInterestHist?symbol=${pair}&period=5m&limit=4`);
  if (Array.isArray(oiHist) && oiHist.length >= 2) {
    const rows = oiHist as Array<{ sumOpenInterestValue?: unknown }>;
    const first = numOrNull(rows[0]?.sumOpenInterestValue);
    const last = numOrNull(rows[rows.length - 1]?.sumOpenInterestValue);
    if (first !== null && last !== null && first > 0) oi = ((last - first) / first) * 100;
  }
  // Global long/short account ratio — retail crowding fades fast.
  let ls: number | null = null;
  const lsRows = await futuresFetch(`/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=5m&limit=1`);
  if (Array.isArray(lsRows) && lsRows.length > 0) {
    const ratio = numOrNull((lsRows[0] as { longShortRatio?: unknown })?.longShortRatio);
    ls = ratio !== null && ratio > 0 ? ratio : null;
  }
  // `at` advances even on total failure — a spot-only listing must not be
  // re-queried three times every 2.5s forever.
  futuresCache.set(pair, { at: Date.now(), funding, oi, ls });
}

async function futuresLoop(): Promise<void> {
  while (!stopped && isCurrentGeneration()) {
    await sleep(FUTURES_TICK_MS);
    if (bannedUntil > Date.now()) continue; // one egress IP — one ban
    const rotation = [...new Set([...wallCandidates, ...pairRooms.keys()])];
    if (rotation.length === 0) continue;
    // First stale entry in rotation order — one pair per tick, ever.
    let pick: string | null = null;
    for (const pair of rotation) {
      const cached = futuresCache.get(pair);
      if (cached === undefined || Date.now() - cached.at > FUTURES_TTL_MS) {
        pick = pair;
        break;
      }
    }
    if (pick === null) continue;
    await refreshFutures(pick);
  }
}

// ── Signals ──────────────────────────────────────────────────────────────────

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

// Signals that, once fired, mean "do not contradict me for an hour" — the
// anti-flip-flop rule. A coin that just dumped or exited cannot go long for
// 60 minutes; a coin that just said "go short" cannot go long for 30.
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

function detectSignals(rows: RadarRow[]): TrackedSignal[] {
  const now = Date.now();
  const fired: TrackedSignal[] = [];
  // §5.2: the portfolio guard correlates candidates against every open
  // position's spark.
  const sparksMap = new Map<string, number[]>(rows.map((r) => [r.pair, r.spark] as const));

  // Shared firing path — cooldown, the per-scan cap, ledger feeds. Returns
  // whether the signal actually fired (the guard must only register real
  // fires, never cap-blocked phantoms).
  const fire = (row: RadarRow, type: SignalType): boolean => {
    const key = `${row.pair}:${type}`;
    const last = cooldowns.get(key) ?? 0;
    const cooldownFor = type === "go_long" || type === "go_short" ? V2.signalRepeatMs : SIGNAL_COOLDOWN_MS;
    if (now - last < cooldownFor) return false;
    if (fired.length >= MAX_SIGNALS_PER_SCAN) return false;
    // Direction-adjusted MFE/MAE run from the moment of the signal.
    const v2Trade = type === "go_long" ? row.v2?.trade ?? null : type === "go_short" ? row.v2?.shortTrade ?? null : null;
    fired.push({
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
      createdAt: now,
      sl: v2Trade ? v2Trade.stop : null,
      tp1: v2Trade ? v2Trade.tp1 : null,
      tp2: v2Trade ? v2Trade.tp2 : null,
      atrPct: v2Trade ? v2Trade.atrPct : null,
      riskPct: v2Trade ? v2Trade.riskPct : null, // §5.2 — outcomes convert to R units
      sentNew: false,
      sent5m: false,
      sent15m: false,
      sent60m: false,
      mfe: 0,
      mae: 0,
      final: false,
    });
    cooldowns.set(key, now);
    // Feed the anti-flip-flop ledger.
    if (BEARISH_TYPES.includes(type)) ledger.bearishSignal(row.pair, now);
    if (type === "go_long") ledger.longSignal(row.pair, now);
    if (type === "go_short") ledger.shortSignal(row.pair, now);
    return true;
  };

  // §2.5/§10: GO candidates fire FIRST, in UNCAPPED v2-score order (shared
  // rankForSignalCut), so the 6-per-scan cap can never eat the best trade in
  // favor of informational signals that happened to sit earlier in row order.
  const goCandidates = rankForSignalCut(
    rows
      .filter((r) => r.v2 !== null && (r.v2.verdict === "go_long" || r.v2.verdict === "go_short"))
      .map((r) => ({
        pair: r.pair,
        score: r.v2 !== null && r.v2.verdict === "go_long" ? r.v2.longScore : (r.v2?.shortScore ?? 0),
        row: r,
      })),
  );
  for (const candidate of goCandidates) {
    const row = candidate.row;
    const side: "long" | "short" = row.v2?.verdict === "go_short" ? "short" : "long";
    const type: SignalType = side === "long" ? "go_long" : "go_short";
    // V2 gated signals — only when the cooldown ledger agrees and the repeat
    // damper is quiet (unchanged semantics).
    const ledgerOk =
      side === "long"
        ? ledger.longAllowed(row.pair, now) && !ledger.repeatLong(row.pair, now)
        : ledger.shortAllowed(row.pair, now) && !ledger.repeatShort(row.pair, now);
    if (!ledgerOk) continue;
    // §5.2 portfolio guard — concurrency, correlation, kill switch.
    const decision = guard.allow(row.pair, side, row.spark, sparksMap);
    if (!decision.ok) {
      // reason null = same pair already open — the cooldown owns that case.
      if (decision.reason !== null) {
        const lastWarn = guardWarnAt.get(row.pair) ?? 0;
        if (now - lastWarn >= 10 * 60_000) {
          guardWarnAt.set(row.pair, now);
          console.warn(`[guard] ${type} on ${row.pair} skipped: ${decision.reason}`);
        }
      }
      continue;
    }
    if (fire(row, type)) guard.register(row.pair, side, row.spark);
  }

  // Informational signals — unchanged rules, pump-score row order.
  for (const row of rows) {
    const candidates: SignalType[] = [];
    const flatDay = row.change24h >= -5 && row.change24h <= 8;
    const flatNow = Math.abs(row.change1m) <= 1 && Math.abs(row.change5m) <= 1;

    if (row.score >= 80 && row.change5m > 0 && row.change24h <= 8) candidates.push("pump_start");
    if (row.rvol >= 3 && flatNow && flatDay) candidates.push("volume_lead");
    if (flatDay && flatNow && row.rvol >= 2 && row.buyPct >= 70) candidates.push("buyer_pressure");
    if (flatDay && flatNow && row.rvol >= 2 && row.buyPct <= 30) candidates.push("seller_pressure");
    if (row.belowHighPct >= 3 && row.rvol >= 2 && row.change5m < 0) candidates.push("dump_start");
    if (row.spikeFalling) candidates.push("spike_collapse");

    for (const type of candidates) fire(row, type);
  }
  return fired;
}

// ── Ingest webhook client ────────────────────────────────────────────────────

async function postIngest(body: unknown): Promise<boolean> {
  try {
    const response = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sift-ingest-key": INGEST_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ── Outcome grading ──────────────────────────────────────────────────────────

// Extended tracked signal with outcome fields filled as it matures.
type GradedSignal = TrackedSignal & {
  price5m?: number;
  change5m?: number;
  price15m?: number;
  change15m?: number;
  price60m?: number;
  change60m?: number;
};

function toApiSignal(s: GradedSignal) {
  return {
    id: s.id,
    pair: s.pair,
    base: s.base,
    type: s.type,
    direction: s.direction,
    score: s.score,
    price: s.price,
    change24h: s.change24h,
    rvol: s.rvol,
    buyPct: s.buyPct,
    volume24h: s.volume24h,
    note: s.note,
    createdAt: new Date(s.createdAt).toISOString(),
    sl: s.sl ?? null,
    tp1: s.tp1 ?? null,
    tp2: s.tp2 ?? null,
    atrPct: s.atrPct ?? null,
    price5m: s.sent5m ? s.price5m ?? null : null,
    change5m: s.sent5m ? s.change5m ?? null : null,
    price15m: s.sent15m ? s.price15m ?? null : null,
    change15m: s.sent15m ? s.change15m ?? null : null,
    price60m: s.sent60m ? s.price60m ?? null : null,
    change60m: s.sent60m ? s.change60m ?? null : null,
    mfe: s.final || s.sent5m ? s.mfe : null,
    mae: s.final || s.sent5m ? s.mae : null,
    status: s.final ? "final" : s.sent15m || s.sent5m ? "partial" : "pending",
  };
}

async function gradeOutcomes(prices: Map<string, number>): Promise<void> {
  const now = Date.now();
  const updates: Array<Record<string, unknown>> = [];
  const newSends: GradedSignal[] = [];

  for (const s of trackedSignals as GradedSignal[]) {
    const price = prices.get(s.pair);
    if (price !== undefined && price > 0) {
      const raw = (price / s.price - 1) * 100;
      const favorable = s.direction === "long" ? raw : -raw;
      if (favorable > s.mfe) s.mfe = favorable;
      if (favorable < s.mae) s.mae = favorable;
    }

    const age = now - s.createdAt;
    const lastPrice = price ?? s.price;

    if (!s.sentNew) newSends.push(s);

    if (!s.sent5m && age >= 5 * 60_000) {
      s.price5m = lastPrice;
      s.change5m = (lastPrice / s.price - 1) * 100;
      s.sent5m = true;
    }
    if (!s.sent15m && age >= 15 * 60_000) {
      s.price15m = lastPrice;
      s.change15m = (lastPrice / s.price - 1) * 100;
      s.sent15m = true;
    }
    if (!s.sent60m && age >= OUTCOME_HORIZON_MS) {
      s.price60m = lastPrice;
      s.change60m = (lastPrice / s.price - 1) * 100;
      s.sent60m = true;
      s.final = true;
      // §5.2: feed the portfolio guard's kill switch at the horizon, in units
      // of risk — direction-adjusted pnl% over the plan's own risk%.
      if (s.type === "go_long" || s.type === "go_short") {
        const favorable = s.direction === "long" ? (s.change60m ?? 0) : -(s.change60m ?? 0);
        guard.registerOutcome(favorable / (s.riskPct || 1));
      }
    }

    if (s.sent5m || s.sent15m || s.sent60m || s.final) {
      updates.push({
        id: s.id,
        price5m: s.price5m ?? null,
        change5m: s.change5m ?? null,
        price15m: s.price15m ?? null,
        change15m: s.change15m ?? null,
        price60m: s.price60m ?? null,
        change60m: s.change60m ?? null,
        mfe: s.mfe,
        mae: s.mae,
        status: s.final ? "final" : s.sent15m || s.sent5m ? "partial" : "pending",
      });
    }
  }

  // Persist newly fired signals (retry until the API accepts them).
  for (const s of newSends) {
    const ok = await postIngest({ mode: "new", signal: toApiSignal(s) });
    if (ok) s.sentNew = true;
    else if (Date.now() - s.createdAt > 10 * 60_000) s.sentNew = true; // give up quietly
  }

  // Batch the outcome updates.
  const matured = updates.filter((u) => u.id !== undefined);
  if (matured.length > 0) {
    await postIngest({ mode: "outcome", updates: matured.slice(0, 200) });
  }

  // Drop finalized signals older than 2 hours from memory (DB holds history).
  for (let i = trackedSignals.length - 1; i >= 0; i -= 1) {
    const s = trackedSignals[i] as GradedSignalAlias;
    if (s.final && now - s.createdAt > 2 * 60 * 60_000) trackedSignals.splice(i, 1);
  }
  // Hard cap on memory.
  while (trackedSignals.length > 800) trackedSignals.shift();
}

type GradedSignalAlias = GradedSignal;

function recentSignalsPayload() {
  return (trackedSignals as GradedSignalAlias[]).slice(-50).reverse().map(toApiSignal);
}

// ── Pair update emission (position tracker) ─────────────────────────────────

async function emitPairUpdate(row: RadarRow): Promise<void> {
  const room = `pair:${row.pair}`;
  if (!pairRooms.has(row.pair)) return;
  const known = knownWalls(row.pair);
  const cached = wallCache.get(row.pair);
  if (cached && Date.now() - cached.at > WALL_TTL_MS) {
    // subscribed pair with stale walls — refresh inline (few, paced by rooms)
    void fetchWalls(row.pair, row.price);
  }
  io.to(room).emit("pair:update", {
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
    askWall: known.ask,
    bidWall: known.bid,
    v2: row.v2,
    spark: row.spark,
    exists: true,
  });
}

async function emitMissingPairUpdate(pair: string): Promise<void> {
  io.to(`pair:${pair}`).emit("pair:update", {
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

// ── The scan loop — pure computation, zero network ────────────────────────────

let scanning = false;
let stopped = false;

async function scan(): Promise<void> {
  if (scanning || stopped || !isCurrentGeneration()) return;
  scanning = true;
  try {
    // The data tasks fill the stores; the scan just reads them. Pairs whose
    // candles haven't arrived yet are skipped, not fatal.
    const pairs = [...new Set([...universe, ...pairRooms.keys()])];
    const rows: RadarRow[] = [];
    const prices = new Map<string, number>();

    // §3.4: BTC's tape FIRST — every other row's beta/residual momentum
    // consumes BTC's closes and 5m/15m moves, and the regime filter consumes
    // BTC's own 15m ATR. BTC itself gets a null context (its residual vs
    // itself is zero by construction, so the engine scores its raw move).
    const btcKlines = candles.get("BTCUSDT") ?? null;
    const btcTicker = stats.get("BTCUSDT") ?? null;
    const btcRow =
      btcKlines !== null && btcTicker !== null
        ? toRow(btcTicker, btcKlines, { closes: null, change5m: null, change15m: null })
        : null;
    const btcCloses = btcKlines !== null ? btcKlines.map((k) => num(k[4])).slice(-60) : null;
    const btcAtr1m =
      btcKlines !== null
        ? atrPctFromCandles(btcKlines.map((k) => ({ high: num(k[2]), low: num(k[3]), close: num(k[4]) })), 14)
        : null;
    const btcAtr15m = atrWindow(btcAtr1m, 15);
    const btcFeed: BtcRowContext = {
      closes: btcCloses,
      change5m: btcRow?.change5m ?? null,
      change15m: btcRow?.change15m ?? null,
    };

    for (const pair of pairs) {
      if (pair === "BTCUSDT" && btcRow !== null) {
        rows.push(btcRow);
        prices.set(pair, btcRow.price);
        continue;
      }
      const k = candles.get(pair);
      const ticker = stats.get(pair);
      if (!k || !ticker) continue;
      const row = toRow(ticker, k, btcFeed);
      if (row) {
        rows.push(row);
        prices.set(row.pair, row.price);
      }
    }
    if (rows.length === 0) {
      consecutiveFailures += 1;
      if (consecutiveFailures <= 2 || consecutiveFailures % 12 === 0) {
        console.error(`[scan] no data yet (failures: ${consecutiveFailures})`);
      }
      return;
    }

    // ── BTC market regime — V2.2: DWELLED with an ATR deadband (audit Part B
    // step 3). One BTC tick can no longer flip the whole market's mode, which
    // moved the GO threshold by 7 points and re-enabled blocked pairs in one
    // shot — the old burst amplifier. Enter bull/dump at 0.5 × BTC's own 15m
    // ATR, leave only under 0.3 × (deadband), and the flip must persist 15 s.
    const nowMs = Date.now();
    const prevRegimeMode = btcRegime?.mode ?? null;
    btcRegime = nextBtcRegime(btcRegime, btcRow?.change15m ?? null, btcAtr15m, nowMs);
    if (btcRow) {
      // V2.2: a regime flip now SHORTENS directional blocks to ≤10 min instead
      // of clearing them (§10 kept the spirit; the burst is gone) — blocked
      // pairs re-enter the candidate pool gradually, not all at once.
      if (prevRegimeMode !== null && prevRegimeMode !== btcRegime.mode) {
        ledger.shortenDirectional(10 * 60_000, nowMs);
      }
      lastBtcMode = btcRegime.mode;
      btcContext = {
        price: btcRow.price,
        change5m: btcRow.change5m,
        change15m: btcRow.change15m,
        change1h: btcRow.spark.length > 0 ? ((btcRow.price - (btcRow.spark[0] ?? btcRow.price)) / (btcRow.spark[0] ?? btcRow.price)) * 100 : 0,
        change24h: btcRow.change24h,
        mode: btcRegime.mode,
      };
    }

    // ── V2 assessment + the STATEFUL VERDICT LAYER (audit Part B step 2).
    // The assessment stays a pure per-snapshot function; the VERDICT the
    // clients see is the state machine's — EWM-smoothed score, confirmation
    // counts, dwell, hysteresis exits, stale-input freeze. Wall data is only
    // fetched for the candidates below, so the rest honestly report "no wall
    // data" in that filter.
    const subscribed = new Set(pairRooms.keys());
    for (const row of rows) {
      const known = knownWalls(row.pair);
      // §2.1: exact-match junk list + pegged-price behaviour.
      const isStable = isJunkBase(row.base) || stablecoinLike(row.price, row.change15m, row.change24h);
      // §4: feed the persistence tracker every scan so wall age accrues; a
      // known-null wall deletes the track (a vanished wall is a NEW wall when
      // it returns).
      const wallAgeSec = known.known ? trackWallAge(wallTracks, row.pair, known.ask) : null;
      const walls = known.known ? (wallCache.get(row.pair) ?? null) : null;
      // V2.2 — depth-snapshot age (wall-score interpolation input) and the
      // wall-absence confirmation clocks.
      const wallDataAgeMs = walls !== null ? Math.max(0, nowMs - walls.at) : null;
      const askAbsentMs = trackWallAbsence(askAbsentSince, row.pair, known.known, known.ask, nowMs);
      const bidAbsentMs = trackWallAbsence(bidAbsentSince, row.pair, known.known, known.bid, nowMs);
      // §4 futures positioning — one missed refresh must not flicker the filter
      // to "no data", but 2×TTL-old data is honestly absent.
      const fut = futuresCache.get(row.pair);
      const futUsable = fut !== undefined && Date.now() - fut.at <= FUTURES_TTL_MS * 2 ? fut : null;
      // V2.2 — data age: the stalest verdict input (klines, and the depth
      // snapshot when one exists). The state machine freezes transitions
      // while this exceeds 3 × the verdict tick — a cold pair's kline
      // rotation landing a block must never move its verdict.
      const klineAgeMs = candleAt.has(row.pair) ? Math.max(0, nowMs - (candleAt.get(row.pair) ?? nowMs)) : 0;
      const dataAgeMs = Math.max(klineAgeMs, wallDataAgeMs ?? 0);
      const priorLong = verdictLongStates.get(row.pair) ?? null;
      const priorShort = verdictShortStates.get(row.pair) ?? null;
      const priorLongGo = priorLong?.name === "go" || priorLong?.name === "demoting";
      const priorShortGo = priorShort?.name === "go" || priorShort?.name === "demoting";
      const { row: v2, long: longAssess, short: shortAssess } = assessRowWithSides(
        {
          base: row.base,
          price: row.price,
          change1m: row.change1m,
          change5m: row.change5m,
          change15m: row.change15m,
          change24h: row.change24h,
          vol5mUsd: row.vol5mUsd,
          rvol: row.rvol,
          trades5m: row.trades5m,
          buyPct: row.buyPct,
          baseScore: row.score,
          atrPct: row.atrPct,
          askWall: known.ask,
          bidWall: known.bid,
          askWallKnown: known.known,
          wallBrokenConfirmed: wallBreakState(row.pair, row.price, known.ask),
          btcChange15m: btcContext?.change15m ?? null,
          btcChange1h: btcContext?.change1h ?? null,
          isStablecoin: isStable,
          // ── V2.1 feeds (§2.3/§3.4/§4/§2.5) ──
          tradeSpike: row.tradeSpike,
          closeStrength: row.closeStrength,
          beta: row.beta ?? null,
          residChange5m: row.residChange5m ?? null,
          residChange15m: row.residChange15m ?? null,
          btcChange5m: btcContext?.change5m ?? null,
          btcAtr15m,
          spreadBps: walls !== null ? walls.spreadBps : null,
          wallAgeSec,
          wallToDepthRatio: walls !== null ? walls.askWallToDepth : null,
          askDepthToTp2Usd: walls !== null ? walls.askDepthUsd : null,
          cvdSlope15m: row.cvdSlope15m ?? null,
          avgTradeSizeSpike: row.avgTradeSizeSpike ?? null,
          oiChange15m: futUsable !== null ? futUsable.oi : null,
          fundingRatePct: futUsable !== null ? futUsable.funding : null,
          lsRatio: futUsable !== null ? futUsable.ls : null,
          listingAgeDays: listingAge.get(row.pair) ?? null,
          historyBlocks: row.historyBlocks ?? null,
          // ── V2.2 feeds (verdict layer) ──
          btcModeOverride: btcRegime.mode,
          wallDataAgeMs,
          askWallAbsentMs: askAbsentMs,
          bidWallAbsentMs: bidAbsentMs,
        },
        null,
        { priorLongGo, priorShortGo },
      );
      // Advance the state machines (the 3 s scan IS the verdict tick).
      const longNext = nextVerdictState(priorLong, "long", longAssess, btcRegime.mode, nowMs, dataAgeMs, liveCfg, isStable || guard.killed(nowMs));
      const shortNext = nextVerdictState(priorShort, "short", shortAssess, btcRegime.mode, nowMs, dataAgeMs, liveCfg, isStable || guard.killed(nowMs));
      verdictLongStates.set(row.pair, longNext);
      verdictShortStates.set(row.pair, shortNext);
      // Instrumentation: every state-name change lands in the change log
      // (raw score, smoothed score, data age, first failing gate) — the
      // stability chip and flip-ratio metrics read exactly this.
      if (longNext.name !== (priorLong?.name ?? "inactive")) {
        verdictChangeLog.unshift({
          pair: row.pair,
          side: "long",
          at: nowMs,
          from: priorLong?.name ?? "inactive",
          to: longNext.name,
          scoreSmooth: longNext.scoreSmooth,
          rawScore: v2.longScore,
          dataAgeMs,
          firstFailingGate: longAssess.demoteGate,
          reason: longNext.lastChangeReason,
        });
        if (verdictChangeLog.length > VERDICT_CHANGE_LOG_MAX) verdictChangeLog.length = VERDICT_CHANGE_LOG_MAX;
      }
      if (shortNext.name !== (priorShort?.name ?? "inactive")) {
        verdictChangeLog.unshift({
          pair: row.pair,
          side: "short",
          at: nowMs,
          from: priorShort?.name ?? "inactive",
          to: shortNext.name,
          scoreSmooth: shortNext.scoreSmooth,
          rawScore: v2.shortScore,
          dataAgeMs,
          firstFailingGate: shortAssess.demoteGate,
          reason: shortNext.lastChangeReason,
        });
        if (verdictChangeLog.length > VERDICT_CHANGE_LOG_MAX) verdictChangeLog.length = VERDICT_CHANGE_LOG_MAX;
      }
      // The overlay: the state machine's verdict replaces the raw one on the
      // wire; the stateless verdict survives in rawVerdict for shadow mode.
      overlayVerdictState(v2, longAssess, shortAssess, longNext, shortNext, liveCfg, isStable);
      v2.dataAgeMs = dataAgeMs;
      row.v2 = v2;
    }

    // V2.2 — pinned emission order (audit Part B.4/B.6): GO states first,
    // rows pinned after leaving GO/watch second, then the rest ranked by the
    // smoothed v2 score. A visible coin can no longer be bumped out of sight
    // by a new candidate until its pin expires.
    rows.sort((a, b) => {
      const rankA = verdictSortRank(a.v2?.state ?? a.v2?.shortState ?? null, nowMs);
      const rankB = verdictSortRank(b.v2?.state ?? b.v2?.shortState ?? null, nowMs);
      if (rankA !== rankB) return rankA - rankB;
      const scoreA = a.v2?.state?.scoreSmooth ?? a.v2?.longScore ?? a.score;
      const scoreB = b.v2?.state?.scoreSmooth ?? b.v2?.longScore ?? b.score;
      return scoreB - scoreA || b.rvol - a.rvol;
    });
    // Keep the payload sane: full checklists + scenarios for the top 20 and
    // subscribed pairs; scores + verdict + warnings for the long tail.
    const detailRank = new Map<string, number>();
    rows.forEach((r, i) => detailRank.set(r.pair, i));
    for (const row of rows) {
      const v2 = row.v2;
      if (!v2) continue;
      const rank = detailRank.get(row.pair) ?? 999;
      if (rank > 20 && !subscribed.has(row.pair)) {
        v2.checks = [];
        v2.shortChecks = [];
        v2.scenarios = [];
        v2.trade = null;
        v2.shortTrade = null;
      }
    }

    // Depth budget goes to the rows that can actually produce a GO verdict.
    wallCandidates = rows
      .filter((r) => r.score >= WALL_CANDIDATE_MIN_SCORE || (r.v2 !== null && (r.v2.verdict === "go_long" || r.v2.verdict === "go_short" || r.v2.verdict === "watch")))
      .slice(0, WALL_CANDIDATE_LIMIT)
      .map((r) => r.pair);

    scans += 1;
    consecutiveFailures = 0;
    lastSnapshot = {
      rows,
      updatedAt: new Date().toISOString(),
      universe: universe.length,
      clients: io.engine.clientsCount,
      scans,
      stale: bannedUntil > Date.now(),
      btc: btcContext,
      stability: stabilityStats(verdictChangeLog, nowMs, { cadenceMs: liveCfg.scanCadenceMs }),
    };
    io.emit("radar:snapshot", lastSnapshot);

    // Per-pair updates for subscribed coin sheets.
    for (const row of rows) {
      if (pairRooms.has(row.pair)) await emitPairUpdate(row);
    }

    // Signal detection + broadcast.
    const fired = detectSignals(rows);
    for (const s of fired) {
      trackedSignals.push(s);
      io.emit("signal:new", toApiSignal(s as GradedSignal));
    }
    // Outcome grading + persistence.
    await gradeOutcomes(prices);
  } finally {
    scanning = false;
  }
}

function scheduleNext(): void {
  if (stopped || !isCurrentGeneration()) return;
  const timer = setTimeout(() => {
    void scan().finally(() => scheduleNext());
  }, SCAN_INTERVAL_MS);
  // Track the timer so a hot reload can stop this loop before starting a new
  // one — otherwise `bun --hot` stacks duplicate scan loops on every edit.
  (globalThis as unknown as { __siftRadarTimer?: ReturnType<typeof setTimeout> }).__siftRadarTimer = timer;
}

// Hourly prune of the persisted log (tracked so a hot reload can cancel the
// previous generation's interval).
{
  const g = globalThis as unknown as { __siftRadarPrune?: ReturnType<typeof setInterval> };
  if (g.__siftRadarPrune) clearInterval(g.__siftRadarPrune);
  g.__siftRadarPrune = setInterval(() => {
    if (!isCurrentGeneration()) return;
    void postIngest({ mode: "prune", days: 7 });
  }, PRUNE_INTERVAL_MS);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

// Hot-reload safety: `bun --hot` re-runs this module on file changes but old
// timers keep firing — stop the previous scan loop and close the previous
// servers before booting the new generation, or requests multiply and the
// upstream bans us.
{
  const g = globalThis as unknown as {
    __siftRadarTimer?: ReturnType<typeof setTimeout>;
    __siftRadarServers?: { http: typeof httpServer; rest: typeof restServer };
  };
  if (g.__siftRadarTimer) clearTimeout(g.__siftRadarTimer);
  if (g.__siftRadarServers) {
    try {
      g.__siftRadarServers.http.close();
      g.__siftRadarServers.rest.close();
    } catch {
      /* old generation already gone */
    }
  }
  g.__siftRadarServers = { http: httpServer, rest: restServer };
}

httpServer.listen(PORT, () => {
  console.log(`[sift-radar] scanner listening on :${PORT} (socket.io) and :${INTERNAL_PORT} (internal REST)`);
  // Boot order: prime the universe + first candles, then run the paced data
  // tasks and the compute-only scan loop forever.
  void (async () => {
    try {
      await refreshUniverse();
    } catch {
      console.error("[boot] universe fetch failed — the universe task will retry");
    }
    // Prime candles for the whole universe before the first scan so clients
    // that connect early still get rows (one paced pass, no burst).
    for (const pair of universe) {
      if (bannedUntil > Date.now()) break;
      try {
        const payload = await binanceFetch(
          `/api/v3/klines?symbol=${pair}&interval=1m&limit=${KLINE_LIMIT}`,
          10_000,
        );
        if (Array.isArray(payload) && (payload as Kline[]).length >= 16) {
          candles.set(pair, payload as Kline[]);
          candleAt.set(pair, Date.now()); // V2.2 — verdict data-age clock
        }
      } catch {
        break; // banned or unreachable — the pump will keep trying
      }
      await sleep(pumpPaceMs());
    }
    console.log(`[boot] primed ${candles.size} pairs, starting loops`);
    void klinePumpLoop();
    void statsTaskLoop();
    void universeTaskLoop();
    void wallPumpLoop();
    void futuresLoop();
    scheduleNext();
  })();
});
restServer.listen(INTERNAL_PORT);

process.on("SIGTERM", () => {
  stopped = true;
  httpServer.close(() => process.exit(0));
  restServer.close();
});
process.on("SIGINT", () => {
  stopped = true;
  httpServer.close(() => process.exit(0));
  restServer.close();
});
