import { NextRequest, NextResponse } from "next/server";
import { buildSpecialPage, isSpecialSyncing, syncSpecialEvents } from "@/lib/special-situations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET ?days=60: events by theme. Starts a background sync when due (hourly). */
export async function GET(req: NextRequest) {
  const days = Math.min(180, Math.max(7, Number(req.nextUrl.searchParams.get("days")) || 60));
  void syncSpecialEvents().catch(() => {});
  try {
    return NextResponse.json({ ok: true, syncing: isSpecialSyncing(), ...buildSpecialPage(days) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** POST: sync now (waits) — used by the Refresh button. */
export async function POST() {
  try {
    const r = await syncSpecialEvents(true);
    return NextResponse.json({ ok: true, ...r, ...buildSpecialPage(60) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
