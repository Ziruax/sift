import type { Coin, MoverSignal, RangeKey, WindowKey, SignalType, SignalDirection } from "./types";

// ── Signal metadata (labels, hints, directions — shared by all views) ───────

export const SIGNAL_META: Record<
  SignalType,
  { label: string; short: string; direction: SignalDirection; hint: string; tone: "up" | "down" | "warn" | "info" }
> = {
  pump_start: {
    label: "Pump starting",
    short: "Pump",
    direction: "long",
    tone: "up",
    hint: "Score 80+ with price already moving up on a day that is not already pumped.",
  },
  volume_lead: {
    label: "Volume leading",
    short: "Vol lead",
    direction: "long",
    tone: "info",
    hint: "3x+ volume spike on a still-flat coin — the money arrived before the move.",
  },
  buyer_pressure: {
    label: "Buyers in control",
    short: "Go long",
    direction: "long",
    tone: "up",
    hint: "Flat coin, but takers are buying 70%+ of a rising-volume tape.",
  },
  seller_pressure: {
    label: "Sellers in control",
    short: "Go short",
    direction: "short",
    tone: "down",
    hint: "Flat coin, but takers are selling 70%+ of a rising-volume tape.",
  },
  dump_start: {
    label: "Dump starting",
    short: "Dump",
    direction: "short",
    tone: "down",
    hint: "3%+ below the session high with a volume spike and falling 5m price.",
  },
  spike_collapse: {
    label: "Spike collapsing",
    short: "Exit",
    direction: "short",
    tone: "warn",
    hint: "A 3x+ volume spike collapsed under 1.5x — the crowd that arrived is leaving.",
  },
};

export const SIGNAL_ORDER: SignalType[] = [
  "pump_start",
  "volume_lead",
  "buyer_pressure",
  "seller_pressure",
  "dump_start",
  "spike_collapse",
];

// ── Mover helpers ───────────────────────────────────────────────────────────

export function changeOf(coin: Coin, window: WindowKey): number {
  if (window === "15m") return coin.change15m;
  if (window === "30m") return coin.change30m;
  return coin.change1h;
}

export function moverSignalFor(windowChange: number, dayChange: number): MoverSignal {
  if (windowChange >= 0 && dayChange < -0.4) return "bounce";
  if (windowChange >= 0) return "run";
  if (dayChange > 0.4) return "fade";
  return "slide";
}

export const MOVER_LABEL: Record<MoverSignal, string> = {
  bounce: "Bounce",
  run: "Run",
  fade: "Fade",
  slide: "Slide",
};

export const MOVER_HINT: Record<MoverSignal, string> = {
  bounce: "Up in this window, still red on the day — the turn may be early.",
  run: "Up in this window and green on the day — the move is already underway.",
  fade: "Down in this window after a green day — the bid is slipping.",
  slide: "Down in this window and red on the day — selling is still in control.",
};

export const WINDOW_LABEL: Record<WindowKey, string> = {
  "15m": "15 minutes",
  "30m": "30 minutes",
  "1h": "1 hour",
};

export const RANGE_LABEL: Record<RangeKey, string> = {
  "1d": "1D",
  "7d": "7D",
  "1m": "1M",
  "3m": "3M",
  "1y": "1Y",
  max: "MAX",
};

// ── Formatters ──────────────────────────────────────────────────────────────

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  let max = 2;
  if (abs > 0 && abs < 0.000001) max = 10;
  else if (abs < 0.0001) max = 8;
  else if (abs < 0.01) max = 6;
  else if (abs < 1) max = 4;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: max,
  }).format(value);
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const units = [
    { n: 1e12, s: "T" },
    { n: 1e9, s: "B" },
    { n: 1e6, s: "M" },
    { n: 1e3, s: "K" },
  ];
  for (const unit of units) {
    if (abs >= unit.n) {
      const scaled = abs / unit.n;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${sign}$${scaled.toFixed(digits)}${unit.s}`;
    }
  }
  return formatPrice(value);
}

export function formatSupply(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const units = [
    { n: 1e12, s: "T" },
    { n: 1e9, s: "B" },
    { n: 1e6, s: "M" },
    { n: 1e3, s: "K" },
  ];
  for (const unit of units) {
    if (abs >= unit.n) {
      const scaled = abs / unit.n;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${scaled.toFixed(digits)}${unit.s}`;
    }
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatMultiple(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}×`;
}

export function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDay(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) {
    out.push(rows[Math.round(i * step)] as T);
  }
  return out;
}

export function pairForSymbol(symbol: string): string {
  const clean = symbol
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  return clean ? `${clean}USDT` : "";
}
