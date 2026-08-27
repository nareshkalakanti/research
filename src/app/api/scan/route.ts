import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies } from "@/lib/db";
import { filterCompaniesByScanList } from "@/lib/scan-lists-server";
import {
  breakoutCounts,
  clearAllWeeklySignals,
  invalidateBreakoutCache,
  latestSignalDates,
  loadBreakoutMap,
  runSignalBatch,
  uncheckedTickers,
  type BbTimeframe,
  type ScanKind,
} from "@/lib/signals";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  kind?: ScanKind;
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
  clearFirst?: boolean;
  bbTimeframe?: BbTimeframe;
};

function filterScanUniverse<T extends { ticker: string; market: string }>(
  companies: T[],
  list: string,
  all: T[],
): T[] {
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
  const kind: ScanKind =
    body.kind === "bb" ||
    body.kind === "tq" ||
    body.kind === "ema" ||
    body.kind === "ath" ||
    body.kind === "high52" ||
    body.kind === "dd" ||
    body.kind === "mom" ||
    body.kind === "both" ||
    body.kind === "all"
      ? body.kind
      : "all";
  const market = body.market || "All";
  const bbTimeframe: BbTimeframe =
    body.bbTimeframe === "monthly" ? "monthly" : "weekly";
  const limit = Math.min(
    kind === "mom" ? 20 : 80,
    Math.max(1, Number(body.limit) || (kind === "mom" ? 12 : 40)),
  );
  const clearFirst = body.clearFirst === true;
  const missingOnly = clearFirst ? false : body.missingOnly !== false;

  if (clearFirst) {
    clearAllWeeklySignals();
  }

  const allCompanies = loadAllCompanies();
  let companies = filterScanUniverse(allCompanies, market, allCompanies);
  if (body.tickers?.length) {
    const set = new Set(body.tickers.map((t) => t.toUpperCase()));
    companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
  }

  if (missingOnly) {
    const pending = uncheckedTickers(
      companies.map((c) => c.ticker),
      kind,
      { bbTimeframe },
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
      athHits: 0,
      high52Hits: 0,
      ddHits: 0,
      momHits: 0,
      failed: 0,
      remaining: 0,
      bbTickers: [],
      tqTickers: [],
      emaTickers: [],
      athTickers: [],
      high52Tickers: [],
      ddTickers: [],
      momTickers: [],
      cleared: clearFirst,
      bbTimeframe,
      signals: breakoutCounts(loadBreakoutMap(bbTimeframe)),
      message: "Nothing left to scan for this filter",
    });
  }

  const result = await runSignalBatch(batch, kind, {
    concurrency: kind === "mom" ? 2 : 4,
    bbTimeframe,
  });
  if (result.error) {
    return NextResponse.json(
      { ok: false, error: result.error, ...result, bbTimeframe },
      { status: 503 },
    );
  }
  invalidateBreakoutCache();

  let remUniverse = filterScanUniverse(loadAllCompanies(), market, allCompanies);
  if (body.tickers?.length) {
    const set = new Set(body.tickers.map((t) => t.toUpperCase()));
    remUniverse = remUniverse.filter((c) => set.has(c.ticker.toUpperCase()));
  }
  const remaining = uncheckedTickers(
    remUniverse.map((c) => c.ticker),
    kind,
    { bbTimeframe },
  ).size;

  const map = loadBreakoutMap(bbTimeframe);
  return NextResponse.json({
    ok: true,
    ...result,
    remaining,
    cleared: clearFirst,
    bbTimeframe,
    session: latestSignalDates(map),
    signals: breakoutCounts(map),
  });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "BB/TQ scan failed unexpectedly";
    console.error("[scan]", e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const bbTimeframe =
    req.nextUrl.searchParams.get("bbTf") === "monthly" ? "monthly" : "weekly";
  const map = loadBreakoutMap(bbTimeframe);
  return NextResponse.json({
    ok: true,
    bbTimeframe,
    signals: breakoutCounts(map),
  });
}
