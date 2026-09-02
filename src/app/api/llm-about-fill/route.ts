import { NextRequest, NextResponse } from "next/server";
import { fillLlmAboutBatch } from "@/lib/llm-about";

export const runtime = "nodejs";
export const maxDuration = 180;

type Body = {
  market?: string;
  tickers?: string[];
  limit?: number;
};

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  try {
    const result = await fillLlmAboutBatch({
      market: body.market || "All",
      tickers: body.tickers,
      limit: Math.min(20, Math.max(1, Number(body.limit) || 8)),
      concurrency: 2,
    });
    return NextResponse.json({
      ok: true,
      ...result,
      message:
        result.saved > 0
          ? `Wrote LLM about for ${result.saved} · ${result.remaining.toLocaleString()} left`
          : result.tried === 0
            ? "No About gaps for this filter"
            : "LLM could not write About for this batch",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "LLM about fill failed";
    return NextResponse.json({ ok: false, message }, { status: 503 });
  }
}
