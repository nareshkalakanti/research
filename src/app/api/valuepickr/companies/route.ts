import { NextResponse } from "next/server";
import { loadValuepickrBoard } from "@/lib/valuepickr-board";

export const runtime = "nodejs";

export async function GET() {
  try {
    const board = loadValuepickrBoard();
    return NextResponse.json({
      ok: true,
      companies: board.companies.map((c) => ({
        company_id: c.company_id,
        company_name: c.company_name,
        ticker: c.ticker,
        signal: c.row.signal,
        mentions_30d: c.row.components.mentions_30d,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
