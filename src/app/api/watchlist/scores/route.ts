import { NextRequest, NextResponse } from "next/server";
import { holdingsScoreJob, savedReviewRows, startHoldingsSlowScoring, tickersNeedingScore } from "@/lib/portfolio-review";
import { screenerPausedUntil } from "@/lib/screener-fetch";

export const runtime = "nodejs";

/**
 * GET /api/watchlist/scores?tickers=A,B,C (any watchlist view)
 * Portfolio-review scores (fundamental / management / quality / valuation /
 * total / rating) from saved scores only. Nothing is fetched unless asked:
 * `&score=1` queues stocks without a current score for a slow background job
 * (one at a time, ~1 a minute) so Screener isn't hammered.
 */
const clean = (xs: unknown): string[] =>
  Array.isArray(xs) ? [...new Set(xs.map((t) => String(t).trim().toUpperCase()).filter(Boolean))].slice(0, 2000) : [];

/**
 * POST { tickers: open list, all: every Watchlist stock, score?: true }
 * Saved scores for every stock in `all`. With score: true, stocks without a current score are
 * queued in the background — the open list first, the rest behind it.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { tickers?: unknown; all?: unknown; score?: boolean };
  const first = clean(body.tickers);
  const all = [...new Set([...first, ...clean(body.all)])];
  try {
    const saved = savedReviewRows(all);
    const missingAll = all.filter((t) => !saved.has(t));
    let job = holdingsScoreJob();
    if (body.score) {
      const due = tickersNeedingScore(all);
      const dueSet = new Set(due);
      if (due.length) job = startHoldingsSlowScoring(first.filter((t) => dueSet.has(t)), { later: due });
    }
    return NextResponse.json({
      ok: true,
      scores: Object.fromEntries(saved),
      total: all.length,
      scored: saved.size,
      missing: missingAll.length,
      job,
      screener_paused_until: screenerPausedUntil(),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}

export async function GET(req: NextRequest) {
  const tickers = (req.nextUrl.searchParams.get("tickers") || "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 500);
  try {
    const saved = savedReviewRows(tickers);
    const missing = tickers.filter((t) => !saved.has(t));
    const due = req.nextUrl.searchParams.get("score") === "1" ? tickersNeedingScore(tickers) : [];
    const job = due.length ? startHoldingsSlowScoring(due) : holdingsScoreJob();
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
