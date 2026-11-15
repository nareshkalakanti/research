import { NextRequest, NextResponse } from "next/server";
import { openSqliteNamed } from "@/lib/sqlite-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The app's own sector › sub-sector for one stock (same label Scan and Rotation use). */
export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker) return NextResponse.json({ ok: false, error: "Need ticker" }, { status: 400 });
  try {
    const db = openSqliteNamed("classifications.db", { readonly: true, wal: true });
    try {
      const row = db
        .prepare(
          `SELECT sector, sub_sector FROM classifications
           WHERE UPPER(ticker) = ? AND TRIM(COALESCE(sector, '')) != '' LIMIT 1`,
        )
        .get(ticker) as { sector: string; sub_sector: string | null } | undefined;
      return NextResponse.json({
        ok: true,
        ticker,
        sector: row?.sector ?? null,
        sub_sector: row?.sub_sector ?? null,
      });
    } finally {
      db.close();
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
