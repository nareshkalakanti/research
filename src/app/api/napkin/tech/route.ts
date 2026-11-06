import { NextRequest, NextResponse } from "next/server";
import { getMetrics } from "@/lib/metrics";
import { resolveListingMarket } from "@/lib/listing-market";
import { loadNapkinTechSignals } from "@/lib/napkin/tech-signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "")
    .trim()
    .toUpperCase();
  if (!ticker) {
    return NextResponse.json(
      { ok: false, error: "ticker required" },
      { status: 400 },
    );
  }
  const market =
    req.nextUrl.searchParams.get("market") ||
    getMetrics(ticker)?.market ||
    resolveListingMarket(ticker);
  try {
    const tech = await loadNapkinTechSignals(ticker, market);
    return NextResponse.json({ ok: true, ticker, tech });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "tech signals failed",
      },
      { status: 500 },
    );
  }
}
