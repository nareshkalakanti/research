import { NextRequest, NextResponse } from "next/server";
import {
  generateConcallDriftReview,
  type ConcallDriftContext,
} from "@/lib/concall-drift-review";
import { getLlmStatus } from "@/lib/company-brief";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("status") === "1") {
    const llm = await getLlmStatus();
    return NextResponse.json({ ok: true, llm });
  }
  return NextResponse.json({ ok: false, error: "POST required" }, { status: 405 });
}

export async function POST(req: NextRequest) {
  let body: {
    ticker?: string;
    price?: number | null;
    drift?: ConcallDriftContext;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  const ticker = (body.ticker || "").trim().toUpperCase();
  if (!ticker || !body.drift?.earn_at) {
    return NextResponse.json(
      { ok: false, error: "ticker and drift context required" },
      { status: 400 },
    );
  }

  try {
    const result = await generateConcallDriftReview(
      ticker,
      body.drift,
      body.price ?? null,
    );

    if (!result.review) {
      return NextResponse.json({
        ok: false,
        error: result.error || "Could not generate concall review",
        hint: result.hint,
      });
    }

    return NextResponse.json({ ok: true, review: result.review });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Review failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
