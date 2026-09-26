import { NextRequest, NextResponse } from "next/server";
import { runSmaFillBatch } from "@/lib/sma-fill";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: {
    market?: string;
    tickers?: string[];
    limit?: number;
    concurrency?: number;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  try {
    const result = await runSmaFillBatch({
      market: body.market || "All",
      tickers: Array.isArray(body.tickers) ? body.tickers : [],
      limit: body.limit,
      concurrency: body.concurrency,
    });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "SMA fill failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
