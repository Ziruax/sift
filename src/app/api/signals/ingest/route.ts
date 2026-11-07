import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { SIGNAL_ORDER } from "@/lib/market/format";

export const dynamic = "force-dynamic";

// Webhook the radar mini-service POSTs into: new signals, outcome updates for
// maturing signals, and a prune call that keeps the log bounded.
// Guarded by a shared secret header so nothing else can write to the log.

const INGEST_KEY = process.env.SIFT_INGEST_KEY ?? "sift-local-dev-key";
const VALID_TYPES = new Set<string>(SIGNAL_ORDER);

type NewSignalPayload = {
  mode: "new";
  signal: {
    id: string; // deterministic "<pair>:<type>:<epochMinute>"
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
    createdAt: string;
    mfe: number;
    mae: number;
  };
};

type OutcomePayload = {
  mode: "outcome";
  updates: Array<{
    id: string;
    price5m?: number | null;
    change5m?: number | null;
    price15m?: number | null;
    change15m?: number | null;
    price60m?: number | null;
    change60m?: number | null;
    mfe?: number | null;
    mae?: number | null;
    status?: "pending" | "partial" | "final";
  }>;
};

type PrunePayload = { mode: "prune"; days?: number };

type Payload = NewSignalPayload | OutcomePayload | PrunePayload;

export async function POST(request: Request) {
  const key = request.headers.get("x-sift-ingest-key");
  if (key !== INGEST_KEY) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    if (payload.mode === "new") {
      const s = payload.signal;
      if (
        !/^[A-Z0-9]{5,16}:[a-z_]+:\d{5,12}$/.test(s.id) ||
        !VALID_TYPES.has(s.type) ||
        !Number.isFinite(s.score) ||
        !Number.isFinite(s.price)
      ) {
        return NextResponse.json({ error: "Malformed signal" }, { status: 400 });
      }
      await db.signal.upsert({
        where: { id: s.id },
        create: {
          id: s.id,
          pair: s.pair,
          base: s.base,
          type: s.type,
          direction: s.direction === "short" ? "short" : "long",
          score: Math.round(Math.max(0, Math.min(100, s.score))),
          price: s.price,
          change24h: s.change24h,
          rvol: s.rvol,
          buyPct: s.buyPct,
          volume24h: s.volume24h,
          note: s.note,
          createdAt: new Date(s.createdAt),
          mfe: s.mfe,
          mae: s.mae,
          status: "pending",
        },
        update: {
          mfe: s.mfe,
          mae: s.mae,
        },
      });
      return NextResponse.json({ ok: true, id: s.id });
    }

    if (payload.mode === "outcome") {
      let applied = 0;
      for (const u of payload.updates.slice(0, 200)) {
        if (!/^[A-Z0-9]{5,16}:[a-z_]+:\d{5,12}$/.test(u.id)) continue;
        const data: Record<string, number | string | null> = {};
        for (const field of ["price5m", "change5m", "price15m", "change15m", "price60m", "change60m", "mfe", "mae"] as const) {
          const v = u[field];
          if (typeof v === "number" && Number.isFinite(v)) data[field] = v;
        }
        if (u.status === "pending" || u.status === "partial" || u.status === "final") data.status = u.status;
        if (Object.keys(data).length === 0) continue;
        await db.signal.update({ where: { id: u.id }, data }).catch(() => {
          /* signal row may have been pruned — skip */
        });
        applied += 1;
      }
      return NextResponse.json({ ok: true, applied });
    }

    if (payload.mode === "prune") {
      const days = typeof payload.days === "number" ? Math.min(Math.max(payload.days, 1), 90) : 7;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const removed = await db.signal.deleteMany({ where: { createdAt: { lt: cutoff } } });
      return NextResponse.json({ ok: true, removed: removed.count });
    }

    return NextResponse.json({ error: "Unknown mode" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ingest failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
