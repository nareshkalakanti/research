import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies } from "@/lib/db";
import {
  forwardPeCount,
  invalidateForwardPeCache,
  loadForwardPeMap,
  missingForwardPeTickers,
  runForwardPeBatch,
} from "@/lib/forward-pe";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  tickers?: string[];
  market?: string;
  limit?: number;
  /** Skip tickers that already have Fwd PE (default true). */
  missingOnly?: boolean;
};

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "")
    .trim()
    .toUpperCase();
  if (ticker) {
    const row = loadForwardPeMap().get(ticker);
    return NextResponse.json({
      ok: true,
      ticker,
      forward_pe: row?.forward_pe ?? null,
      latest_eps: row?.latest_eps ?? null,
      quarter_end: row?.quarter_end ?? null,
      price: row?.price ?? null,
      fetched_at: row?.fetched_at ?? null,
    });
  }
  const map = loadForwardPeMap();
  return NextResponse.json({
    ok: true,
    total: map.size,
    withPe: forwardPeCount(map),
  });
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const market = body.market || "NSE";
  const limit = Math.min(80, Math.max(1, Number(body.limit) || 60));
  const missingOnly = body.missingOnly !== false;

  let companies = loadAllCompanies();
  if (market && market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }
  if (body.tickers?.length) {
    const set = new Set(body.tickers.map((t) => t.toUpperCase()));
    companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
  }

  if (missingOnly) {
    const pending = missingForwardPeTickers(companies.map((c) => c.ticker));
    companies = companies.filter((c) => pending.has(c.ticker.toUpperCase()));
  }

  const batch = companies.slice(0, limit).map((c) => ({
    ticker: c.ticker,
    market: c.market,
    price: c.price,
  }));

  if (!batch.length) {
    return NextResponse.json({
      ok: true,
      tried: 0,
      saved: 0,
      failed: 0,
      remaining: 0,
      withPe: forwardPeCount(),
      message: "Nothing left to fill for this filter",
    });
  }

  const result = await runForwardPeBatch(batch, { concurrency: 8 });
  invalidateForwardPeCache();

  let rem = loadAllCompanies();
  if (market && market !== "All") {
    rem = rem.filter((c) => c.market === market);
  }
  if (body.tickers?.length) {
    const set = new Set(body.tickers.map((t) => t.toUpperCase()));
    rem = rem.filter((c) => set.has(c.ticker.toUpperCase()));
  }
  const remaining = missingForwardPeTickers(rem.map((c) => c.ticker)).size;

  return NextResponse.json({
    ok: true,
    ...result,
    remaining,
    withPe: forwardPeCount(),
  });
}
