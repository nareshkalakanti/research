import { NextRequest, NextResponse } from "next/server";
import { holdingsScoreJob, savedReviewRows, startHoldingsSlowScoring } from "@/lib/portfolio-review";
import { screenerPausedUntil } from "@/lib/screener-fetch";

export const runtime = "nodejs";

/**
 * GET /api/watchlist/scores?tickers=A,B,C (any watchlist view)
 * Portfolio-review scores (fundamental / management / quality / valuation /
 * total / rating) from saved scores only; stocks without one are queued for a
 * slow background job (one at a time, ~1 a minute) so Screener isn't hammered.
 */
export async function GET(req: NextRequest) {
  const tickers = (req.nextUrl.searchParams.get("tickers") || "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 500);
  try {
    const saved = savedReviewRows(tickers);
    const missing = tickers.filter((t) => !saved.has(t));
    const job = missing.length ? startHoldingsSlowScoring(missing) : holdingsScoreJob();
    // Same row as Portfolio review (scores + the checklists its drawer shows).
    const scores = Object.fromEntries([...saved].map(([t, r]) => [t, r]));
    return NextResponse.json({
      ok: true,
      scores,
      missing: missing.length,
      job,
      screener_paused_until: screenerPausedUntil(),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
