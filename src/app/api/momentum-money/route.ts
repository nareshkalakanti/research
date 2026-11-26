import { NextRequest, NextResponse } from "next/server";
import { buildMomentumMoney, candleStudies, stockChart } from "@/lib/momentum-money";

export const runtime = "nodejs";

/**
 * GET /api/momentum-money?year=2025          → that year's winners with the study measures (from closes)
 * GET /api/momentum-money?year=2025&ticker=X → one winner's chart: weekly bars, study, old IPO2 entries
 * GET /api/momentum-money?ticker=X[&market=]  → the same for any stock (Napkin), trailing-year study
 */
export async function GET(req: NextRequest) {
  try {
    const year = Number(req.nextUrl.searchParams.get("year")) || undefined;
    const ticker = (req.nextUrl.searchParams.get("ticker") || "").trim();
    if (ticker) {
      const c = await stockChart(ticker, { year, market: req.nextUrl.searchParams.get("market") });
      return NextResponse.json(c, { status: c.ok ? 200 : 404 });
    }
    return NextResponse.json({ ok: true, ...(await buildMomentumMoney(year)) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}

/**
 * POST /api/momentum-money { year, tickers } → the same study from daily candles (highs / lows),
 * fetched from Yahoo once a day per stock and saved.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { year?: number; tickers?: string[] };
    const year = Number(body.year);
    const tickers = Array.isArray(body.tickers) ? body.tickers.filter((t) => typeof t === "string").slice(0, 400) : [];
    if (!year || !tickers.length) return NextResponse.json({ ok: false, error: "year and tickers needed" }, { status: 400 });
    return NextResponse.json({ ok: true, studies: await candleStudies(year, tickers) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
