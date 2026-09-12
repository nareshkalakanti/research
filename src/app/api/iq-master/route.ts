import { NextRequest, NextResponse } from "next/server";
import { buildIqMasterRows } from "@/lib/iq-master";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/iq-master?tickers=A,B,C — compose tracker rows from existing DBs. */
export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("tickers") || "";
    const tickers = raw
      .split(/[,|\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tickers.length) {
      return NextResponse.json({ ok: true, rows: [] });
    }
    const rows = buildIqMasterRows(tickers);
    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "IQMaster failed",
        rows: [],
      },
      { status: 500 },
    );
  }
}
