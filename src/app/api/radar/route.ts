import { NextResponse } from "next/server";
import type { RadarSnapshot } from "@/lib/market/types";

export const dynamic = "force-dynamic";

// REST proxy to the radar mini-service — the fallback path when a browser
// cannot hold a websocket. Same snapshot the socket pushes, 3s timeout.
export async function GET() {
  try {
    const response = await fetch("http://127.0.0.1:3004/snapshot", {
      cache: "no-store",
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) throw new Error(`radar service responded ${response.status}`);
    const snapshot = (await response.json()) as RadarSnapshot;
    return NextResponse.json(snapshot);
  } catch {
    return NextResponse.json(
      {
        rows: [],
        updatedAt: new Date().toISOString(),
        universe: 0,
        clients: 0,
        scans: 0,
        stale: true,
        error: "The radar scanner is not answering. It restarts itself automatically — retry in a few seconds.",
      },
      { status: 503 },
    );
  }
}
