import { NextRequest, NextResponse } from "next/server";
import {
  addToReview,
  buildReview,
  FUND,
  listReviewTickers,
  parseReviewBag,
  removeFromReview,
  resolveTickers,
  scoreReviewTicker,
  startReviewScoring,
  type ReviewBag,
} from "@/lib/portfolio-review";
// parseReviewBag re-exported from portfolio-review (types + server)
import { screenerPausedUntil } from "@/lib/screener-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bagOf(req: Request, bodyBag?: string | null): ReviewBag {
  const sp = new URL(req.url).searchParams;
  return parseReviewBag(bodyBag ?? sp.get("bag"));
}

/** GET: review list · `?tickers=1` · `?bag=` · `?score=TICKER` (one-stock Portfolio model for Napkin). */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const bag = bagOf(req);
    const scoreT = (sp.get("score") || "").trim().toUpperCase();
    if (scoreT) {
      const row = await scoreReviewTicker(scoreT, { fresh: sp.get("fresh") === "1" });
      return NextResponse.json({
        ok: true,
        row,
        rules: FUND,
        screener_paused_until: screenerPausedUntil(),
      });
    }
    if (sp.get("tickers") === "1") {
      return NextResponse.json({ ok: true, bag, tickers: listReviewTickers(bag) });
    }
    const fresh = sp.get("fresh") === "1";
    return NextResponse.json({
      ok: true,
      bag,
      rules: FUND,
      ...(await buildReview({ fresh, bag })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** POST {add: string[]} · {remove: ticker} · {clear: true} · {score: true} (start background scoring) · optional {bag}. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    add?: string[];
    remove?: string;
    clear?: boolean;
    score?: boolean;
    bag?: string;
  };
  const bag = bagOf(req, body.bag);
  try {
    if (body.score) {
      return NextResponse.json({ ok: true, bag, ...startReviewScoring(bag) });
    }
    if (body.clear) {
      removeFromReview(null, bag);
      return NextResponse.json({ ok: true, bag });
    }
    if (body.remove) {
      removeFromReview(body.remove, bag);
      return NextResponse.json({ ok: true, bag });
    }
    const inputs = (body.add ?? []).map(String).filter((s) => s.trim()).slice(0, 500);
    const { found, missing } = resolveTickers(inputs);
    const added = addToReview(found, bag);
    return NextResponse.json({ ok: true, bag, added, found, missing });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
