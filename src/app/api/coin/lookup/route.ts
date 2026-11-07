import { NextResponse } from "next/server";
import { lookupByPair } from "@/lib/market/paprika";

export const dynamic = "force-dynamic";

// Resolve a Binance pair ("PEPEUSDT") to its CoinPaprika coin detail, used
// when a coin page is opened straight from the radar or the signal log.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const pair = (url.searchParams.get("pair") ?? "").toUpperCase();
  if (!/^[A-Z0-9]{5,16}$/.test(pair)) {
    return NextResponse.json({ found: false, detail: null }, { status: 400 });
  }
  try {
    const detail = await lookupByPair(pair);
    return NextResponse.json({ found: detail !== null, detail });
  } catch {
    return NextResponse.json({ found: false, detail: null }, { status: 502 });
  }
}
