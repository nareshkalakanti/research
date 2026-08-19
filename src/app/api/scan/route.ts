import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies } from "@/lib/db";
import {
  breakoutCounts,
  clearAllWeeklySignals,
  invalidateBreakoutCache,
  latestSignalDates,
  loadBreakoutMap,
  runSignalBatch,
  uncheckedTickers,
  type ScanKind,
} from "@/lib/signals";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  kind?: ScanKind;
  market?: string;
  tickers?: string[];
  limit?: number;
  /** Skip tickers already scanned this week (default true). */
  missingOnly?: boolean;
  /** Wipe weekly BB/TQ + scan progress before this batch (full rescan). */
  clearFirst?: boolean;
};

function filterCompaniesByMarket<T extends { market: string }>(
  companies: T[],
  market: string,
): T[] {
  if (!market || market === "All") return companies;
  if (market === "NSE") {
    return companies.filter(
      (c) => c.market === "NSE" || c.market === "NSE SME",
    );
  }
  return companies.filter((c) => c.market === market);
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  try {
  const kind: ScanKind =
    body.kind === "bb" ||
    body.kind === "tq" ||
    body.kind === "ema" ||
    body.kind === "both" ||
    body.kind === "all"
      ? body.kind
      : "all";
  const market = body.market || "NSE";
  const limit = Math.min(80, Math.max(1, Number(body.limit) || 40));
  const clearFirst = body.clearFirst === true;
  // After a wipe, every ticker is pending — don't skip.
  const missingOnly = clearFirst ? false : body.missingOnly !== false;

  if (clearFirst) {
    clearAllWeeklySignals();
  }

  let companies = loadAllCompanies();
  companies = filterCompaniesByMarket(companies, market);
  if (body.tickers?.length) {
    const set = new Set(body.tickers.map((t) => t.toUpperCase()));
    companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
  }

  if (missingOnly) {
    const pending = uncheckedTickers(
      companies.map((c) => c.ticker),
      kind,
    );
    companies = companies.filter((c) => pending.has(c.ticker.toUpperCase()));
  }

  const batch = companies.slice(0, limit).map((c) => ({
    ticker: c.ticker,
    market: c.market,
  }));

  if (!batch.length) {
    return NextResponse.json({
      ok: true,
      tried: 0,
      bbHits: 0,
      tqHits: 0,
      emaHits: 0,
      failed: 0,
      remaining: 0,
      bbTickers: [],
      tqTickers: [],
      emaTickers: [],
      cleared: clearFirst,
      signals: breakoutCounts(),
      message: "Nothing left to scan for this filter",
    });
  }

  const result = await runSignalBatch(batch, kind, { concurrency: 4 });
  invalidateBreakoutCache();

  let remUniverse = loadAllCompanies();
  remUniverse = filterCompaniesByMarket(remUniverse, market);
  if (body.tickers?.length) {
    const set = new Set(body.tickers.map((t) => t.toUpperCase()));
    remUniverse = remUniverse.filter((c) => set.has(c.ticker.toUpperCase()));
  }
  const remaining = uncheckedTickers(
    remUniverse.map((c) => c.ticker),
    kind,
  ).size;

  return NextResponse.json({
    ok: true,
    ...result,
    remaining,
    cleared: clearFirst,
    session: latestSignalDates(),
    signals: breakoutCounts(loadBreakoutMap()),
  });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "BB/TQ scan failed unexpectedly";
    console.error("[scan]", e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    signals: breakoutCounts(loadBreakoutMap()),
  });
}
