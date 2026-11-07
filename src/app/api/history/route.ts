import { NextResponse } from "next/server";
import { getHistory } from "@/lib/market/history";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const result = await getHistory({
      symbol: url.searchParams.get("symbol") ?? undefined,
      range: url.searchParams.get("range") ?? undefined,
      id: url.searchParams.get("id") ?? undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "History is unavailable right now.";
    return NextResponse.json({ error: message, points: [], source: "none" }, { status: 502 });
  }
}
