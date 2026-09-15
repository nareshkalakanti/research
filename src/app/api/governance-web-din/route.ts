import { NextRequest, NextResponse } from "next/server";
import {
  pendingWebDinJobs,
  runWebDinScanBatch,
} from "@/lib/board-din-web";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
};

export async function GET(req: NextRequest) {
  const market = req.nextUrl.searchParams.get("market") || "All";
  const pending = pendingWebDinJobs({ market, missingOnly: true });
  return NextResponse.json({
    ok: true,
    pending: pending.length,
    market,
  });
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const market = body.market || "All";
  const limit = Math.min(12, Math.max(1, Number(body.limit) || 5));
  const missingOnly = body.missingOnly !== false;

  const result = await runWebDinScanBatch({
    market,
    tickers: body.tickers,
    limit,
    missingOnly,
  });

  return NextResponse.json({
    ok: true,
    ...result,
    message:
      result.tried === 0
        ? "Nothing left for Web DIN scan"
        : result.saved
          ? `Web DIN · saved ${result.saved} · +${result.new_dins.length} DIN`
          : `Web DIN · tried ${result.tried} · none saved`,
  });
}
