import { NextRequest, NextResponse } from "next/server";
import {
  pendingGovernanceJobs,
  runGovernanceScanBatch,
} from "@/lib/governance-scan";
import { dinBoardTickerSet } from "@/lib/governance-write";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  market?: string;
  tickers?: string[];
  limit?: number;
  /**
   * true (default): only tickers without a DIN board yet.
   * false: refresh given tickers (or pending universe) via upsert — never wipes DB.
   */
  missingOnly?: boolean;
};

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const market = body.market || "NSE";
  const limit = Math.min(30, Math.max(1, Number(body.limit) || 10));
  const missingOnly = body.missingOnly !== false;

  const result = await runGovernanceScanBatch({
    market,
    tickers: body.tickers,
    limit,
    missingOnly,
    concurrency: 2,
  });

  return NextResponse.json({
    ok: true,
    ...result,
    message:
      result.tried === 0
        ? "Nothing left to scan for this filter"
        : result.new_dins.length || result.new_directors.length
          ? `Saved ${result.saved} · +${result.new_dins.length} DIN · +${result.new_directors.length} directors`
          : `Saved ${result.saved} · no new DINs/directors`,
  });
}

export async function GET(req: NextRequest) {
  const market = req.nextUrl.searchParams.get("market") || "NSE";
  const pending = pendingGovernanceJobs({ market, missingOnly: true });
  const dinDone = dinBoardTickerSet().size;
  return NextResponse.json({
    ok: true,
    pending: pending.length,
    din_boards: dinDone,
  });
}
