import { NextResponse } from "next/server";
import { loadValuepickrBoard } from "@/lib/valuepickr-board";

export const runtime = "nodejs";

export async function GET() {
  try {
    const board = loadValuepickrBoard();
    return NextResponse.json({ ok: true, posts: board.latest });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
