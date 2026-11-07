import { NextResponse } from "next/server";
import { getBoard } from "@/lib/market/paprika";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const board = await getBoard({
      window: url.searchParams.get("window") ?? undefined,
      book: url.searchParams.get("book") ?? undefined,
    });
    return NextResponse.json(board);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live prices are unavailable right now.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
