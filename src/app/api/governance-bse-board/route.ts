import { NextRequest, NextResponse } from "next/server";
import { pendingBseBoardJobs, runBseBoardBatch } from "@/lib/bse-board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: BSE main-board companies still without a DIN board (not tried in 14 days). */
export async function GET() {
  return NextResponse.json({ ok: true, pending: pendingBseBoardJobs().length });
}

/** POST {tickers?, limit?}: one batch — BSE CorpInfo (CIN + roles) → registry DINs → saved board. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { tickers?: string[]; limit?: number };
  try {
    return NextResponse.json({ ok: true, ...(await runBseBoardBatch({ tickers: body.tickers, limit: body.limit })) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
