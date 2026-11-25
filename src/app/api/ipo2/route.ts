import { NextRequest, NextResponse } from "next/server";
import { buildIpo2Screen, stockBasesDetail } from "@/lib/ipo2";

export const runtime = "nodejs";

/**
 * GET /api/ipo2              → stocks listed in the last 4 years, stage and entries
 * GET /api/ipo2?refresh=1    → rebuild (and wait for fresh NSE listing dates)
 * GET /api/ipo2?ticker=X[&market=] → one stock's bases / entries for a chart (IPO rules if listed
 *                                in the last 4 years, else the normal base rules)
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  try {
    const ticker = (sp.get("ticker") || "").trim();
    if (ticker) {
      const d = await stockBasesDetail(ticker, sp.get("market"));
      return NextResponse.json(d, { status: d.ok ? 200 : 404 });
    }
    const result = await buildIpo2Screen({ refresh: sp.get("refresh") === "1" });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
