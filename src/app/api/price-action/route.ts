import { NextRequest, NextResponse } from "next/server";
import { buildPriceAction, PA_2WK_DAYS } from "@/lib/price-action-screen";

export const runtime = "nodejs";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/price-action            → last 11 trading days (2WK)
 * GET /api/price-action?days=1     → latest day only
 * GET /api/price-action?from=&to=  → custom dates (YYYY-MM-DD, up to 45 trading days)
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from") || undefined;
  const to = sp.get("to") || undefined;
  if ((from && !ISO.test(from)) || (to && !ISO.test(to))) {
    return NextResponse.json({ ok: false, error: "Dates must be YYYY-MM-DD" }, { status: 400 });
  }
  const days = Number(sp.get("days")) || PA_2WK_DAYS;
  try {
    const result = await buildPriceAction({ from, to, days });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}
