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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server, type Socket } from "socket.io";

// ── Configuration ────────────────────────────────────────────────────────────

const PORT = 3003;
// The vision mirror first; api.binance.com as failover for network errors.
// 418/429 bans are per-IP and handled with hard, doubling backoff.
const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api4.binance.com"];
const SCAN_INTERVAL_MS = 5_000; // compute + emit cadence (no network)
const UNIVERSE_LIMIT = 40;
const UNIVERSE_REFRESH_MS = 5 * 60_000;
const KLINE_LIMIT = 60; // 60 × 1m = one hour of candles
const STATS_REFRESH_MS = 60_000; // 24h ticker stats cadence
const SIGNAL_COOLDOWN_MS = 10 * 60_000; // per pair+type
const MAX_SIGNALS_PER_SCAN = 6;
const OUTCOME_HORIZON_MS = 60 * 60_000;
const WALL_TTL_MS = 15_000;
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
};

type RadarSnapshot = {
  rows: RadarRow[];
  updatedAt: string;
  universe: number;
  clients: number;
  scans: number;
  stale: boolean;
};

type SignalType =
  | "pump_start"
  | "volume_lead"
  | "buyer_pressure"
  | "seller_pressure"
  | "dump_start"
  | "spike_collapse";

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

const STABLE_BASES = new Set(["USDT", "USDC", "FDUSD", "DAI", "TUSD", "USDP", "BUSD"]);
const FIAT_BASES = new Set([
  "EUR", "GBP", "BRL", "AUD", "TRY", "NGN", "UAH", "ARS", "MXN", "ZAR", "PLN", "CZK", "HUF", "ILS",
]);
const LEVERAGED_SUFFIXES = ["UP", "DOWN", "BULL", "BEAR"];
const PEGGED_BASES = new Set([
  "RLUSD", "USD1", "USDE", "USD0", "PYUSD", "EURC", "USDD", "FRAX", "LUSD", "GUSD", "XUSD", "RWUSD", "XAUT", "PAXG",
]);

function isBStock(base: string): boolean {
  return base.length >= 3 && base.length <= 6 && base.endsWith("B");
}

// ── Scanner state ────────────────────────────────────────────────────────────

type Ticker24h = {
  symbol?: unknown;
  lastPrice?: unknown;
  quoteVolume?: unknown;
  priceChangePercent?: unknown;
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
const wallCache = new Map<string, { at: number; wall: { price: number; valueUsd: number } | null }>();

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
    return { ...lastSnapshot, clients: io.engine.clientsCount, stale: consecutiveFailures > 0 };
  }
  return {
    rows: [],
    updatedAt: new Date().toISOString(),
    universe: universe.length,
    clients: io.engine.clientsCount,
    scans,
    stale: false,
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
  return Math.round(Math.min(100, Math.max(0, rvolPts + tradePts + momentumPts + buyPts + closePts)));
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

function toRow(ticker: Ticker24h, klines: Kline[]): RadarRow | null {
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

  // Twelve 5-minute blocks in the last hour = the baseline.
  const blocks: number[] = [];
  const tradeBlocks: number[] = [];
  for (let start = 0; start + 5 <= quotes.length; start += 5) {
    blocks.push(quotes.slice(start, start + 5).reduce((a, b) => a + b, 0));
    tradeBlocks.push(trades.slice(start, start + 5).reduce((a, b) => a + b, 0));
  }
  const volAvg5m = blocks.length > 0 ? blocks.reduce((a, b) => a + b, 0) / blocks.length : 0;
  const tradeAvg5m = tradeBlocks.length > 0 ? tradeBlocks.reduce((a, b) => a + b, 0) / tradeBlocks.length : 0;
  const vol5m = quotes.slice(-5).reduce((a, b) => a + b, 0);
  const trades5m = trades.slice(-5).reduce((a, b) => a + b, 0);
  const rvol = volAvg5m > 0 ? vol5m / volAvg5m : 0;
  const tradeSpike = tradeAvg5m > 0 ? trades5m / tradeAvg5m : 0;

  const buyQuote5m = takerBuys.slice(-5).reduce((a, b) => a + b, 0);
  const buyPct = vol5m > 0 ? (buyQuote5m / vol5m) * 100 : 50;

  // Close strength: average (close − low) / (high − low) over the last 5
  // candles. High == low (flat candle) counts as neutral 0.5.
  let strengthSum = 0;
  let strengthCount = 0;
  for (const k of klines.slice(-5)) {
    const high = num(k[2]);
    const low = num(k[3]);
    const close = num(k[4]);
    if (high > low) {
      strengthSum += (close - low) / (high - low);
      strengthCount += 1;
    }
  }
  const closeStrength = strengthCount > 0 ? strengthSum / strengthCount : 0.5;

  const price = closes.length > 0 ? closes[closes.length - 1] ?? 0 : num(ticker.lastPrice);
  if (price <= 0) return null;
  const sessionHigh = Math.max(sessionHighs.get(pair) ?? 0, ...closes, price);
  sessionHighs.set(pair, sessionHigh);
  const belowHighPct = sessionHigh > 0 ? ((sessionHigh - price) / sessionHigh) * 100 : 0;

  const volumeLead = rvol >= 3 && Math.abs(change5m) <= 1 && Math.abs(change1m) <= 1;
  const prevRvol = lastRvol.get(pair) ?? null;
  lastRvol.set(pair, rvol);
  const spikeFalling = prevRvol !== null && prevRvol >= 3 && rvol < 1.5;

  const score = pumpScore(rvol, tradeSpike, change1m, change5m, change15m, buyPct, closeStrength);
  const change24h = num(ticker.priceChangePercent);
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
  const rows = (payload as Ticker24h[])
    .filter((row) => {
      const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : "";
      if (!symbol.endsWith("USDT")) return false;
      const base = symbol.slice(0, -4);
      if (!base || STABLE_BASES.has(base) || FIAT_BASES.has(base) || PEGGED_BASES.has(base)) return false;
      if (isBStock(base)) return false;
      if (LEVERAGED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return false;
      return num(row.quoteVolume) > 0;
    })
    .sort((a, b) => num(b.quoteVolume) - num(a.quoteVolume))
    .slice(0, UNIVERSE_LIMIT);
  const nextUniverse: string[] = [];
  const nextStats = new Map<string, Ticker24h>();
  for (const row of rows) {
    const symbol = String(row.symbol).toUpperCase();
    nextUniverse.push(symbol);
    nextStats.set(symbol, row);
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
  // Drop candles for pairs that left the universe (keep subscribed extras).
  const keep = new Set([...nextUniverse, ...pairRooms.keys()]);
  for (const pair of candles.keys()) {
    if (!keep.has(pair)) {
      candles.delete(pair);
      sessionHighs.delete(pair);
      lastRvol.delete(pair);
    }
  }
}

function pumpPaceMs(): number {
  for (const tier of WEIGHT_TIERS) {
    if (lastUsedWeight < tier.maxWeight) return tier.paceMs;
  }
  return WEIGHT_TIERS[WEIGHT_TIERS.length - 1]?.paceMs ?? 500;
}

async function klinePumpLoop(): Promise<void> {
  let cursor = 0;
  const failureStreaks = new Map<string, number>();
  while (!stopped && isCurrentGeneration()) {
    await sleep(pumpPaceMs());
    if (bannedUntil > Date.now()) continue;
    const rotation = [...universe, ...pairRooms.keys()];
    if (rotation.length === 0) continue;
    const pair = rotation[cursor % rotation.length];
    cursor += 1;
    if (!pair) continue;
    try {
      const payload = await binanceFetch(
        `/api/v3/klines?symbol=${pair}&interval=1m&limit=${KLINE_LIMIT}`,
        10_000,
      );
      if (Array.isArray(payload) && (payload as Kline[]).length >= 16) {
        candles.set(pair, payload as Kline[]);
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

// ── Sell wall (subscribed pairs only) ────────────────────────────────────────

async function getAskWall(pair: string, price: number): Promise<{ price: number; valueUsd: number } | null> {
  if (price <= 0) return null;
  const cached = wallCache.get(pair);
  if (cached && Date.now() - cached.at < WALL_TTL_MS) return cached.wall;
  try {
    const payload = (await binanceFetch(`/api/v3/depth?symbol=${pair}&limit=20`, 8_000)) as {
      asks?: Array<[string, string]>;
    };
    const asks = Array.isArray(payload.asks) ? payload.asks : [];
    let best: { price: number; valueUsd: number } | null = null;
    for (const [rawPrice, rawQty] of asks) {
      const askPrice = num(rawPrice);
      const qty = num(rawQty);
      if (askPrice <= 0 || askPrice > price * 1.02) continue;
      const valueUsd = askPrice * qty;
      if (!best || valueUsd > best.valueUsd) best = { price: askPrice, valueUsd };
    }
    wallCache.set(pair, { at: Date.now(), wall: best });
    return best;
  } catch {
    // Feed failed — hide the wall rather than fake one, but retry soon.
    wallCache.set(pair, { at: Date.now() - WALL_TTL_MS + 3_000, wall: null });
    return null;
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
};

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
  }
}

function detectSignals(rows: RadarRow[]): TrackedSignal[] {
  const now = Date.now();
  const fired: TrackedSignal[] = [];
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

    for (const type of candidates) {
      const key = `${row.pair}:${type}`;
      const last = cooldowns.get(key) ?? 0;
      if (now - last < SIGNAL_COOLDOWN_MS) continue;
      // Direction-adjusted MFE/MAE run from the moment of the signal.
      fired.push({
        id: `${row.pair}:${type}:${Math.floor(now / 60_000)}`,
        pair: row.pair,
        base: row.base,
        type,
        direction: DIRECTION[type],
        score: row.score,
        price: row.price,
        change24h: row.change24h,
        rvol: row.rvol,
        buyPct: row.buyPct,
        volume24h: row.volume24h,
        note: signalNote(type, row),
        createdAt: now,
        sentNew: false,
        sent5m: false,
        sent15m: false,
        sent60m: false,
        mfe: 0,
        mae: 0,
        final: false,
      });
      cooldowns.set(key, now);
      if (fired.length >= MAX_SIGNALS_PER_SCAN) return fired;
    }
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
  const wall = await getAskWall(row.pair, row.price);
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
    askWall: wall,
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
    for (const pair of pairs) {
      const k = candles.get(pair);
      const ticker = stats.get(pair);
      if (!k || !ticker) continue;
      const row = toRow(ticker, k);
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

    rows.sort((a, b) => b.score - a.score || b.rvol - a.rvol);
    scans += 1;
    consecutiveFailures = 0;
    lastSnapshot = {
      rows,
      updatedAt: new Date().toISOString(),
      universe: universe.length,
      clients: io.engine.clientsCount,
      scans,
      stale: bannedUntil > Date.now(),
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
