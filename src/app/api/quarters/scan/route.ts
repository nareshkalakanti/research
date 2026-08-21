import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies } from "@/lib/db";
import { filterCompaniesByScanList } from "@/lib/scan-lists-server";
import { isAllGreenMetrics, loadQuarterMetricsMap } from "@/lib/quarter-metrics-cache";
import {
  runQuarterMetricsBatch,
  tickersMissingQuarterMetrics,
} from "@/lib/quarter-metrics-compute";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
};

function filterUniverse(
  companies: ReturnType<typeof loadAllCompanies>,
  list: string,
  all: ReturnType<typeof loadAllCompanies>,
) {
  return filterCompaniesByScanList(companies, list, all);
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  try {
    const market = body.market || "All";
    const limit = Math.min(30, Math.max(1, Number(body.limit) || 15));
    const missingOnly = body.missingOnly !== false;

    const allCompanies = loadAllCompanies();
    let companies = filterUniverse(allCompanies, market, allCompanies);

    if (body.tickers?.length) {
      const set = new Set(body.tickers.map((t) => t.toUpperCase()));
      companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
    }

    if (missingOnly) {
      const pending = tickersMissingQuarterMetrics(
        companies.map((c) => c.ticker),
      );
      companies = companies.filter((c) =>
        pending.has(c.ticker.toUpperCase()),
      );
    }

    const batch = companies.slice(0, limit).map((c) => ({
      ticker: c.ticker,
      market: c.market,
    }));

    if (!batch.length) {
      const qm = loadQuarterMetricsMap();
      let pool = filterUniverse(allCompanies, market, allCompanies);
      if (body.tickers?.length) {
        const set = new Set(body.tickers.map((t) => t.toUpperCase()));
        pool = pool.filter((c) => set.has(c.ticker.toUpperCase()));
      }
      const remaining = tickersMissingQuarterMetrics(
        pool.map((c) => c.ticker),
      ).size;
      let green = 0;
      for (const c of pool) {
        if (isAllGreenMetrics(qm.get(c.ticker.toUpperCase()))) green += 1;
      }
      return NextResponse.json({
        ok: true,
        tried: 0,
        saved: 0,
        failed: 0,
        skipped: 0,
        remaining,
        green,
        message: "All dots filled for this list",
      });
    }

    const result = await runQuarterMetricsBatch(batch, { concurrency: 4 });

    let remPool = filterUniverse(allCompanies, market, allCompanies);
    if (body.tickers?.length) {
      const set = new Set(body.tickers.map((t) => t.toUpperCase()));
      remPool = remPool.filter((c) => set.has(c.ticker.toUpperCase()));
    }
    const remaining = tickersMissingQuarterMetrics(
      remPool.map((c) => c.ticker),
    ).size;

    const qm = loadQuarterMetricsMap();
    let green = 0;
    for (const c of remPool) {
      if (isAllGreenMetrics(qm.get(c.ticker.toUpperCase()))) green += 1;
    }

    return NextResponse.json({
      ok: true,
      ...result,
      remaining,
      green,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Quarter metrics scan failed",
      },
      { status: 500 },
    );
  }
}
