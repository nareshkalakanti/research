import { NextRequest, NextResponse } from "next/server";
import { fundHoldersOf } from "@/lib/screener-people";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/fund-holders?ticker=X → followed funds (Screener people pages) with a 1%+ stake, per quarter. */
export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker") ?? "";
  try {
    return NextResponse.json({ ok: true, ticker: ticker.toUpperCase(), ...fundHoldersOf(ticker) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
