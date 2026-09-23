import { NextResponse } from "next/server";
import { loadHoldings } from "@/lib/holdings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Personal holdings tickers from data/holdings.db */
export async function GET() {
  const rows = loadHoldings();
  return NextResponse.json({
    ok: true,
    tickers: rows.map((r) => r.ticker.toUpperCase()),
    count: rows.length,
  });
}
