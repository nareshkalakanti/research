import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies } from "@/lib/db";
import { fetchDailyBars } from "@/lib/ohlc";
import { filterCompaniesByScanList } from "@/lib/scan-lists-server";
import { latestSpringIhsLong, type SpringIhsRow } from "@/lib/spring-ihs";
import { runConcurrent } from "@/lib/scrape-pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function POST(req: NextRequest) {
  let body: {
    market?: string;
    tickers?: string[];
    limit?: number;
    offset?: number;
    concurrency?: number;
    /** Only tip-bar triggers when true; else last N bars. */
    tipOnly?: boolean;
    lookbackBars?: number;
    yearsBack?: number;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const market = (body.market || "All").trim() || "All";
  const limit = Math.min(200, Math.max(1, num(body.limit, 40)));
  const offset = Math.max(0, num(body.offset, 0));
  const concurrency = Math.min(8, Math.max(2, num(body.concurrency, 5)));
  const tipOnly = body.tipOnly === true;
  const lookbackBars = tipOnly
    ? 0
    : Math.min(40, Math.max(1, num(body.lookbackBars, 10)));
  const yearsBack = Math.min(5, Math.max(1, num(body.yearsBack, 2)));

  const all = loadAllCompanies();
  let pool = filterCompaniesByScanList(all, market, all);
  if (Array.isArray(body.tickers) && body.tickers.length) {
    const want = new Set(
      body.tickers.map((t) => t.trim().toUpperCase()).filter(Boolean),
    );
    pool = pool.filter((c) => want.has(c.ticker.toUpperCase()));
  }
  const batch = pool.slice(offset, offset + limit);
  const hits: SpringIhsRow[] = [];
  let tried = 0;
  let failed = 0;

  await runConcurrent(batch, concurrency, async (co) => {
    tried += 1;
    try {
      const bars = await fetchDailyBars(co.ticker, co.market, yearsBack);
      const hit = latestSpringIhsLong(bars, {
        tipOnly,
        lookbackBars: tipOnly ? undefined : lookbackBars,
      });
      if (!hit) return;
      hits.push({
        ...hit,
        ticker: co.ticker.toUpperCase(),
        name: co.name,
        market: co.market,
      });
    } catch {
      failed += 1;
    }
  });

  hits.sort((a, b) => {
    const d = b.date.localeCompare(a.date);
    if (d) return d;
    return a.ticker.localeCompare(b.ticker);
  });

  const nextOffset = offset + batch.length;
  return NextResponse.json({
    ok: true,
    market,
    tried,
    failed,
    offset,
    nextOffset,
    universe: pool.length,
    remaining: Math.max(0, pool.length - nextOffset),
    hits,
  });
}
