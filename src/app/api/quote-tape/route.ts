import { NextRequest, NextResponse } from "next/server";
import { loadQuoteTape } from "@/lib/quote-tape";
import { getMetrics } from "@/lib/metrics";
import { resolveListingMarket } from "@/lib/listing-market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "")
    .trim()
    .toUpperCase();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  const market =
    req.nextUrl.searchParams.get("market") ||
    getMetrics(ticker)?.market ||
    resolveListingMarket(ticker);
  try {
    const weekly = req.nextUrl.searchParams.get("weekly") === "1";
    const tape = await loadQuoteTape(ticker, market, { weekly });
    return NextResponse.json({ ok: true, ticker, tape });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "quote tape failed",
      },
      { status: 500 },
    );
  }
}
