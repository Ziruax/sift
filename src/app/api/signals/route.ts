import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { SIGNAL_ORDER } from "@/lib/market/format";
import type { MarketSignal, SignalType, SignalTypeStat, SignalsResponse } from "@/lib/market/types";

export const dynamic = "force-dynamic";

const VALID_TYPES = new Set<SignalType>(SIGNAL_ORDER);

function serialize(row: {
  id: string;
  pair: string;
  base: string;
  type: string;
  direction: string;
  score: number;
  price: number;
  change24h: number;
  rvol: number;
  buyPct: number;
  volume24h: number;
  note: string | null;
  createdAt: Date;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  atrPct: number | null;
  price5m: number | null;
  change5m: number | null;
  price15m: number | null;
  change15m: number | null;
  price60m: number | null;
  change60m: number | null;
  mfe: number | null;
  mae: number | null;
  status: string;
}): MarketSignal {
  return {
    id: row.id,
    pair: row.pair,
    base: row.base,
    type: row.type as SignalType,
    direction: row.direction === "short" ? "short" : "long",
    score: row.score,
    price: row.price,
    change24h: row.change24h,
    rvol: row.rvol,
    buyPct: row.buyPct,
    volume24h: row.volume24h,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    sl: row.sl,
    tp1: row.tp1,
    tp2: row.tp2,
    atrPct: row.atrPct,
    price5m: row.price5m,
    change5m: row.change5m,
    price15m: row.price15m,
    change15m: row.change15m,
    price60m: row.price60m,
    change60m: row.change60m,
    mfe: row.mfe,
    mae: row.mae,
    status: row.status === "final" ? "final" : row.status === "partial" ? "partial" : "pending",
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const typeParam = url.searchParams.get("type");
  const pair = (url.searchParams.get("pair") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 120) || 120, 1), 300);
  const type = typeParam && VALID_TYPES.has(typeParam as SignalType) ? (typeParam as SignalType) : null;

  try {
    const where: { type?: string; pair?: string } = {};
    if (type) where.type = type;
    if (pair) where.pair = pair;

    const [rows, total] = await Promise.all([
      db.signal.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      db.signal.count({ where }),
    ]);

    const signals = rows.map(serialize);

    // Stats over the recent window (bounded: last 7 days of that type).
    if (!pair) {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const recent = await db.signal.findMany({
        where: { createdAt: { gte: since } },
        select: {
          type: true,
          direction: true,
          change5m: true,
          change15m: true,
          change60m: true,
          mfe: true,
          mae: true,
          status: true,
        },
      });
      const stats: SignalTypeStat[] = SIGNAL_ORDER.map((t) => {
        const of = recent.filter((r) => r.type === t);
        const finals = of.filter((r) => r.status === "final" && r.change60m !== null);
        const avg = (pick: (r: (typeof recent)[number]) => number | null) => {
          const values = of.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
          if (values.length === 0) return null;
          return values.reduce((a, b) => a + b, 0) / values.length;
        };
        const wins = finals.filter((r) => {
          const change = r.change60m as number;
          return r.direction === "long" ? change > 0 : change < 0;
        }).length;
        return {
          type: t,
          count: of.length,
          finals: finals.length,
          wins,
          winRate: finals.length > 0 ? wins / finals.length : null,
          avgChange5m: avg((r) => r.change5m),
          avgChange15m: avg((r) => r.change15m),
          avgChange60m: avg((r) => r.change60m),
          avgMfe: avg((r) => r.mfe),
          avgMae: avg((r) => r.mae),
        };
      });
      const response: SignalsResponse = { signals, stats, total };
      return NextResponse.json(response);
    }

    const response: SignalsResponse = { signals, stats: [], total };
    return NextResponse.json(response);
  } catch {
    return NextResponse.json({ error: "The signal log is unavailable right now." }, { status: 502 });
  }
}
