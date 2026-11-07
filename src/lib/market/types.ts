// Shared market types — the contract between the Next.js app, its API routes
// and the radar mini-service. Everything here is plain JSON-serializable data.

export const WINDOWS = ["15m", "30m", "1h"] as const;
export type WindowKey = (typeof WINDOWS)[number];

export const BOOKS = ["tradable", "deep"] as const;
export type BookKey = (typeof BOOKS)[number];

export const RANGES = ["1d", "7d", "1m", "3m", "1y", "max"] as const;
export type RangeKey = (typeof RANGES)[number];

export type MoverSignal = "bounce" | "run" | "fade" | "slide";

// ── CoinPaprika coin ────────────────────────────────────────────────────────

export type Coin = {
  id: string;
  name: string;
  symbol: string;
  rank: number;
  price: number;
  volume24h: number;
  marketCap: number;
  change15m: number;
  change30m: number;
  change1h: number;
  change6h: number;
  change24h: number;
  change7d: number;
  change30d: number;
  change1y: number;
  athPrice: number;
  athDate: string | null;
  fromAth: number;
  circulating: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
};

export type GlobalStats = {
  marketCap: number;
  marketCapChange24h: number;
  volume24h: number;
  volumeChange24h: number;
  btcDominance: number;
  listed: number;
};

export type Board = {
  updatedAt: string;
  window: WindowKey;
  book: BookKey;
  global: GlobalStats;
  markets: Coin[];
  rising: Coin[];
  falling: Coin[];
  risingCount: number;
  fallingCount: number;
  stale?: boolean;
};

export type CoinDetail = {
  coin: Coin;
  logo: string | null;
  description: string;
  startedAt: string | null;
  proof: string | null;
  tags: string[];
  website: string | null;
  explorer: string | null;
  whitepaper: string | null;
};

export type PricePoint = {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
};

export type HistoryResult = {
  points: PricePoint[];
  source: "binance" | "llama" | "yahoo" | "none";
};

// ── Radar (mini-service, pushed over socket.io / proxied via /api/radar) ────

export type RadarBadge = "pump" | "early" | "dumping" | "pumped";
export type RadarSignal = "pumping" | "dumping" | "long" | "short" | "flat";

export type RadarRow = {
  pair: string; // e.g. "PEPEUSDT"
  base: string; // e.g. "PEPE"
  price: number;
  change1m: number;
  change5m: number;
  change15m: number;
  change24h: number;
  volume24h: number;
  vol5mUsd: number;
  volAvg5mUsd: number;
  rvol: number; // 5m volume vs the 1h average 5m block (spike multiple)
  tradeSpike: number; // same, but trade count — validates real participation
  trades5m: number;
  buyPct: number; // taker-buy share of the last 5m quote volume
  closeStrength: number; // 0..1, closes near highs = buyers in control
  score: number; // 0..100 opportunity score
  sessionHigh: number;
  belowHighPct: number;
  badge: RadarBadge | null;
  volumeLead: boolean; // volume spiked while price still flat
  spikeFalling: boolean; // 3x+ spike collapsed below 1.5x — buyers leaving
  signal: RadarSignal;
  spark: number[]; // last 60 one-minute closes
};

export type RadarSnapshot = {
  rows: RadarRow[];
  updatedAt: string;
  universe: number;
  clients: number;
  scans: number;
  stale: boolean; // true when the feed failed and this is the last good scan
};

// ── Signals (persisted opportunity log with graded outcomes) ────────────────

export type SignalType =
  | "pump_start"
  | "volume_lead"
  | "buyer_pressure"
  | "seller_pressure"
  | "dump_start"
  | "spike_collapse";

export type SignalDirection = "long" | "short";

export type MarketSignal = {
  id: string;
  pair: string;
  base: string;
  type: SignalType;
  direction: SignalDirection;
  score: number;
  price: number;
  change24h: number;
  rvol: number;
  buyPct: number;
  volume24h: number;
  note: string | null;
  createdAt: string;
  price5m: number | null;
  change5m: number | null;
  price15m: number | null;
  change15m: number | null;
  price60m: number | null;
  change60m: number | null;
  mfe: number | null;
  mae: number | null;
  status: "pending" | "partial" | "final";
};

export type SignalTypeStat = {
  type: SignalType;
  count: number;
  finals: number;
  wins: number; // finals where the market moved in the signal's direction @60m
  winRate: number | null;
  avgChange5m: number | null;
  avgChange15m: number | null;
  avgChange60m: number | null;
  avgMfe: number | null;
  avgMae: number | null;
};

export type SignalsResponse = {
  signals: MarketSignal[];
  stats: SignalTypeStat[];
  total: number;
};

// ── Live pair subscription (position tracker) ───────────────────────────────

export type PairUpdate = {
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
  trades5m: number;
  buyPct: number;
  score: number;
  sessionHigh: number;
  belowHighPct: number;
  volumeLead: boolean;
  spikeFalling: boolean;
  askWall: { price: number; valueUsd: number } | null;
  spark: number[];
  exists: boolean; // false when Binance has no such USDT pair
};
