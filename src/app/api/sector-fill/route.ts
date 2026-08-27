import { NextRequest, NextResponse } from "next/server";
import { fillSectorBatch } from "@/lib/sector-fill";

export const runtime = "nodejs";
export const maxDuration = 120;

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

  const result = await fillSectorBatch({
    market: body.market || "All",
    tickers: body.tickers,
    limit: Math.min(50, Math.max(1, Number(body.limit) || 20)),
    concurrency: 2,
  });

  return NextResponse.json({
    ok: true,
    ...result,
    message:
      result.saved > 0
        ? `Classified ${result.saved}${result.fetched_about ? ` · Yahoo about ${result.fetched_about}` : ""} · ${result.remaining.toLocaleString()} left`
        : result.tried === 0
          ? "No sector gaps for this filter"
          : result.fetched_about > 0
            ? `Fetched Yahoo about for ${result.fetched_about} — could not classify (add API keys or edit manually)`
            : "Could not classify — Yahoo had no about text",
  });
}
