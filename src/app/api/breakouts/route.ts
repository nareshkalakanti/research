import { NextResponse } from "next/server";
import { buildBreakouts } from "@/lib/breakout-screen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/breakouts: today's breakouts from a base, grouped client-side by screen. */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, ...(await buildBreakouts()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
