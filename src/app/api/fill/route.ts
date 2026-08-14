import { NextRequest, NextResponse } from "next/server";
import { invalidateCompanyCache, loadAllCompanies } from "@/lib/db";
import {
  fillBseSmeMetricsGaps,
  metricsGapCount,
  seedBseSmeMcapFromCache,
  upsertMetrics,
} from "@/lib/metrics";
import { fetchQuotes } from "@/lib/yfinance";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  tickers?: string[];
  market?: string;
  limit?: number;
  missingOnly?: boolean;
  preferMcap?: boolean;
};

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const market = body.market || "NSE";
  const limit = Math.min(150, Math.max(1, Number(body.limit) || 50));
  const missingOnly = body.missingOnly !== false;
  const preferMcap = body.preferMcap !== false;

  let companies = loadAllCompanies();
  if (market && market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }

  if (body.tickers?.length) {
    const set = new Set(body.tickers.map((t) => t.toUpperCase()));
    companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
  }

  let pending = companies.filter((c) => {
    if (!missingOnly) return true;
    return c.price == null || c.mcap_cr == null;
  });

  if (preferMcap) {
    pending = [
      ...pending.filter((c) => c.mcap_cr == null),
      ...pending.filter((c) => c.mcap_cr != null && c.price == null),
    ];
    const seen = new Set<string>();
    pending = pending.filter((c) => {
      const t = c.ticker.toUpperCase();
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
  }

  const gapsBefore = metricsGapCount(companies.map((c) => c.ticker));
  const batch = pending.slice(0, limit);

  if (!batch.length) {
    return NextResponse.json({
      ok: true,
      tried: 0,
      saved: 0,
      filledPrice: 0,
      filledMcap: 0,
      failed: 0,
      remaining: gapsBefore.any,
      remainingMcap: companies.filter((c) => c.mcap_cr == null).length,
      gaps: gapsBefore,
      message: "Nothing missing to fill",
    });
  }

  const quotes = await fetchQuotes(
    batch.map((c) => ({ ticker: c.ticker, market: c.market })),
    { concurrency: 4 },
  );

  const marketBy: Record<string, string> = {};
  for (const c of batch) marketBy[c.ticker.toUpperCase()] = c.market;

  let saved = upsertMetrics(quotes, marketBy);

  if (batch.some((c) => c.market === "BSE SME")) {
    seedBseSmeMcapFromCache(batch.map((c) => c.ticker));
    const bse = await fillBseSmeMetricsGaps(batch);
    saved += bse.saved;
  }

  invalidateCompanyCache();

  const afterCompanies = loadAllCompanies().filter((c) =>
    market && market !== "All" ? c.market === market : true,
  );
  const gapsAfter = metricsGapCount(afterCompanies.map((c) => c.ticker));

  let filledPrice = 0;
  let filledMcap = 0;
  let failed = 0;
  for (const q of quotes) {
    if (q.price != null) filledPrice += 1;
    if (q.mcap_cr != null) filledMcap += 1;
    if (q.price == null && q.mcap_cr == null) failed += 1;
  }

  return NextResponse.json({
    ok: true,
    tried: batch.length,
    saved,
    filledPrice,
    filledMcap,
    failed,
    remaining: gapsAfter.any,
    remainingMcap: afterCompanies.filter((c) => c.mcap_cr == null).length,
    gaps: gapsAfter,
    sample: quotes.slice(0, 8).map((q) => ({
      ticker: q.ticker,
      price: q.price,
      mcap_cr: q.mcap_cr,
      yf_symbol: q.yf_symbol,
      error: q.error ?? null,
    })),
  });
}

export async function GET(req: NextRequest) {
  const market = req.nextUrl.searchParams.get("market") || "NSE";
  let companies = loadAllCompanies();
  if (market && market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }
  const gaps = metricsGapCount(companies.map((c) => c.ticker));
  return NextResponse.json({
    market,
    total: companies.length,
    gaps,
    remainingMcap: companies.filter((c) => c.mcap_cr == null).length,
  });
}
