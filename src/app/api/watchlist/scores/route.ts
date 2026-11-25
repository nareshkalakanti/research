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
const clean = (xs: unknown): string[] =>
  Array.isArray(xs) ? [...new Set(xs.map((t) => String(t).trim().toUpperCase()).filter(Boolean))].slice(0, 2000) : [];

/**
 * POST { tickers: open list, all: every Watchlist stock }
 * Scores for every stock in `all`; missing ones are queued — the open list
 * first, the rest behind it — and progress counts cover the whole Watchlist.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { tickers?: unknown; all?: unknown };
  const first = clean(body.tickers);
  const all = [...new Set([...first, ...clean(body.all)])];
  try {
    const saved = savedReviewRows(all);
    const missingFirst = first.filter((t) => !saved.has(t));
    const missingAll = all.filter((t) => !saved.has(t));
    const job = missingAll.length ? startHoldingsSlowScoring(missingFirst, { later: missingAll }) : holdingsScoreJob();
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
