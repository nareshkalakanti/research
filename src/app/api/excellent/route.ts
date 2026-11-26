import { NextRequest, NextResponse } from "next/server";
import { buildScannerData } from "@/lib/scanner";
import { holdingsScoreJob, listReviewTickers, savedReviewRows, startHoldingsSlowScoring, tickersNeedingScore } from "@/lib/portfolio-review";
import { screenerPausedUntil } from "@/lib/screener-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stocks scored for the Excellent list: market cap ₹200 Cr+ and ROCE 15%+. */
const MIN_MCAP_CR = 200;
const MIN_ROCE = 15;
const rank = (rating: string) => (rating === "Excellent" ? 0 : 1);

/**
 * GET /api/excellent: every stock rated Excellent (total 13+ of 17) or Good
 * (9–12) by the Portfolio review, from saved scores only, Excellent first. Nothing is fetched unless
 * asked: `?score=1` queues universe stocks without a current score behind anything already waiting
 * (Watchlist first), one Screener page every 20–30 s.
 */
export async function GET(req: NextRequest) {
  try {
    const universe = buildScannerData().rows.filter(
      (r) => (r.mcap ?? 0) >= MIN_MCAP_CR && (r.roce ?? -Infinity) >= MIN_ROCE,
    );
    const tickers = universe.map((r) => r.t.toUpperCase());
    const saved = savedReviewRows(tickers);
    const missing = tickers.filter((t) => !saved.has(t));
    const due = req.nextUrl.searchParams.get("score") === "1" ? tickersNeedingScore(tickers) : [];
    const job = due.length ? startHoldingsSlowScoring([], { later: due }) : holdingsScoreJob();
    const owned = new Set(listReviewTickers().map((t) => t.toUpperCase()));
    const rows = [...saved.values()]
      .filter((r) => r.rating === "Excellent" || r.rating === "Good")
      .sort((a, b) => rank(a.rating) - rank(b.rating) || b.total - a.total || b.quality - a.quality || (b.mcap ?? 0) - (a.mcap ?? 0))
      .map((r) => ({ ...r, owned: owned.has(r.t.toUpperCase()) }));
    return NextResponse.json({
      ok: true,
      rows,
      universe: tickers.length,
      scored: saved.size,
      missing: missing.length,
      rules: { min_mcap_cr: MIN_MCAP_CR, min_roce: MIN_ROCE },
      job,
      screener_paused_until: screenerPausedUntil(),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
