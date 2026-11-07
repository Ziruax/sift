import { NextResponse } from "next/server";
import { getCoin } from "@/lib/market/paprika";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const detail = await getCoin(id.toLowerCase());
    return NextResponse.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : "This coin couldn't be loaded.";
    const status = message.includes("doesn't look right") || message.includes("isn't on the tape") ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
