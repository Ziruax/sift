import { NextResponse } from "next/server";
import { getSaved } from "@/lib/market/paprika";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  try {
    const coins = await getSaved(ids);
    return NextResponse.json(coins);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Saved coins couldn't be refreshed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
