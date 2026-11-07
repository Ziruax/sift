import { NextResponse } from "next/server";
import { searchCoins } from "@/lib/market/paprika";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  try {
    const coins = await searchCoins(q);
    return NextResponse.json(coins);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search is unavailable right now.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
