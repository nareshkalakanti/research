import { NextRequest, NextResponse } from "next/server";
import { loadValuepickrBoard } from "@/lib/valuepickr-board";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get("q") || "";
    const board = loadValuepickrBoard(q);
    return NextResponse.json({ ok: true, ...board });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
