import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies } from "@/lib/db";
import { edgeTickerSet } from "@/lib/edge";
import { govPsuTickerSet } from "@/lib/gov-psu";
import {
  FUND_WATCHLIST_KEYS,
  type FundFilterState,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";
import {
  activeFundFilterSet,
} from "@/lib/fund-watchlists";
import { holdingsTickerSet } from "@/lib/holdings";
import { notesTickerSet } from "@/lib/notes";
import { filterCompaniesByScanList } from "@/lib/scan-lists-server";
import { isAgeAtLeast, parseAgeMin } from "@/lib/company-age";
import {
  breakoutCounts,
  clearAllWeeklySignals,
  clearEmptyMrsiSignals,
  clearEmptyMomSignals,
  invalidateBreakoutCache,
  latestSignalDates,
  loadBreakoutMap,
  mrsiAttemptedTickers,
  prioritizeMomQueue,
  runSignalBatch,
  uncheckedTickers,
  type BbTimeframe,
  type ScanKind,
} from "@/lib/signals";
import { capTier, type CapTier } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export type ScanScope = "selection" | "list";

type Body = {
  kind?: ScanKind;
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
  clearFirst?: boolean;
  /** Drop null RSI placeholders once before a Scan RSI M refill. */
  clearEmptyMrsi?: boolean;
  /** Drop null 12−1 placeholders once before a Scan 12m refill. */
  clearEmptyMom?: boolean;
  /** Only names missing a monthly RSI value. */
  emptyMrsi?: boolean;
  bbTimeframe?: BbTimeframe;
  /** selection = List + tags/cap; list = List dropdown only */
  scope?: ScanScope;
  cap?: CapTier | "All";
  hold?: boolean;
  edge?: boolean;
  gov?: boolean;
  sme?: boolean;
  note?: boolean;
  ageMin?: number | null;
  age25?: boolean;
  funds?: FundFilterState;
};

function parseFunds(raw: unknown): FundFilterState {
  const out = Object.fromEntries(
    FUND_WATCHLIST_KEYS.map((k) => [k, false]),
  ) as FundFilterState;
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const key of FUND_WATCHLIST_KEYS) {
    if (obj[key] === true || obj[key] === 1 || obj[key] === "1") {
      out[key] = true;
    }
  }
  return out;
}

function applySelectionFilters<
  T extends {
    ticker: string;
    market: string;
    mcap_cr?: number | null;
    founded_year?: string | null;
  },
>(
  companies: T[],
  opts: {
    cap: CapTier | "All";
    hold: boolean;
    edge: boolean;
    gov: boolean;
    sme: boolean;
    note: boolean;
    ageMin: number | null;
    funds: FundFilterState;
  },
): T[] {
  let out = companies;
  if (opts.cap && opts.cap !== "All") {
    out = out.filter((c) => capTier(c.mcap_cr ?? null) === opts.cap);
  }
  if (opts.sme) {
    out = out.filter((c) => /\bSME\b/i.test(c.market));
  }
  if (opts.ageMin != null) {
    out = out.filter((c) => isAgeAtLeast(c.founded_year, opts.ageMin!));
  }
  if (opts.hold) {
    const holdings = holdingsTickerSet();
    out = out.filter((c) => holdings.has(c.ticker.toUpperCase()));
  }
  if (opts.edge) {
    const edge = edgeTickerSet();
    out = out.filter((c) => edge.has(c.ticker.toUpperCase()));
  }
  if (opts.gov) {
    const gov = govPsuTickerSet();
    out = out.filter((c) => gov.has(c.ticker.toUpperCase()));
  }
  const fundFilter = activeFundFilterSet(opts.funds);
  if (fundFilter) {
    out = out.filter((c) => fundFilter.has(c.ticker.toUpperCase()));
  }
  if (opts.note) {
    const notes = notesTickerSet();
    out = out.filter((c) => notes.has(c.ticker.toUpperCase()));
  }
  return out;
}

function hasSelectionFilters(opts: {
  cap: CapTier | "All";
  hold: boolean;
  edge: boolean;
  gov: boolean;
  sme: boolean;
  note: boolean;
  ageMin: number | null;
  funds: FundFilterState;
}): boolean {
  if (opts.cap && opts.cap !== "All") return true;
  if (
    opts.hold ||
    opts.edge ||
    opts.gov ||
    opts.sme ||
    opts.note ||
    opts.ageMin != null
  ) {
    return true;
  }
  return FUND_WATCHLIST_KEYS.some((k) => opts.funds[k as FundWatchlistKey]);
}

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
    body.kind === "mom" ||
    body.kind === "mrsi" ||
    body.kind === "both" ||
    body.kind === "all"
      ? body.kind
      : "all";
  const market = body.market || "All";
  const bbTimeframe: BbTimeframe =
    body.bbTimeframe === "monthly" ? "monthly" : "weekly";
  const limit = Math.min(
    kind === "mom" || kind === "mrsi" ? 20 : 80,
    Math.max(
      1,
      Number(body.limit) || (kind === "mom" || kind === "mrsi" ? 12 : 40),
    ),
  );
  const clearFirst = body.clearFirst === true;
  const missingOnly = clearFirst ? false : body.missingOnly !== false;

  const selection = {
    cap: (body.cap || "All") as CapTier | "All",
    hold: body.hold === true,
    edge: body.edge === true,
    gov: body.gov === true,
    sme: body.sme === true,
    note: body.note === true,
    ageMin:
      parseAgeMin(body.ageMin) ?? (body.age25 === true ? 25 : null),
    funds: parseFunds(body.funds),
  };
  const scope: ScanScope =
    body.scope === "list"
      ? "list"
      : body.scope === "selection"
        ? "selection"
        : hasSelectionFilters(selection)
          ? "selection"
          : "list";

  if (clearFirst) {
    clearAllWeeklySignals();
  } else if (
    body.clearEmptyMrsi === true &&
    (kind === "mrsi" || kind === "all" || body.emptyMrsi === true)
  ) {
    // Drop null RSI rows so Empty / Scan RSI M can refill (Yahoo misses, SME, etc.).
    clearEmptyMrsiSignals();
    invalidateBreakoutCache();
  } else if (
    (kind === "mom" || kind === "all") &&
    body.clearEmptyMom === true
  ) {
    clearEmptyMomSignals();
    invalidateBreakoutCache();
  }

  const allCompanies = loadAllCompanies();
  let companies = filterScanUniverse(allCompanies, market, allCompanies);
  if (scope === "selection" || body.emptyMrsi === true) {
    companies = applySelectionFilters(companies, selection);
  }
  if (body.tickers?.length) {
    const set = new Set(body.tickers.map((t) => t.toUpperCase()));
    companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
  }

  const breakoutsForEmpty =
    body.emptyMrsi === true ? loadBreakoutMap(bbTimeframe) : null;
  if (breakoutsForEmpty) {
    // One-shot queue: only names never written to mrsi_signals (skip null retries).
    const attempted = mrsiAttemptedTickers();
    companies = companies.filter((c) => !attempted.has(c.ticker.toUpperCase()));
  }

  if (missingOnly && body.emptyMrsi !== true) {
    const pending = uncheckedTickers(
      companies.map((c) => c.ticker),
      kind,
      { bbTimeframe },
    );
    companies = companies.filter((c) => pending.has(c.ticker.toUpperCase()));
  }

  // MOM / MRSI: prefer never-tried names so short-history / SME don't block the queue.
  if (kind === "mom" || kind === "mrsi" || kind === "all") {
    companies = prioritizeMomQueue(
      companies,
      kind === "mrsi" ? "mrsi" : "mom",
    );
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
      momHits: 0,
      mrsiHits: 0,
      failed: 0,
      remaining: 0,
      bbTickers: [],
      tqTickers: [],
      emaTickers: [],
      athTickers: [],
      high52Tickers: [],
      momTickers: [],
      mrsiTickers: [],
      cleared: clearFirst,
      bbTimeframe,
      scope,
      signals: breakoutCounts(loadBreakoutMap(bbTimeframe)),
      message: "Nothing left to scan for this filter",
    });
  }

  const result = await runSignalBatch(batch, kind, {
    concurrency: kind === "mom" ? 2 : kind === "mrsi" ? 6 : 4,
    bbTimeframe,
  });
  // Soft-skip TQ when Nifty is down — don't fail the whole Scan all / BB batch.
  if (result.error && kind === "tq") {
    return NextResponse.json(
      { ok: false, error: result.error, ...result, bbTimeframe, scope },
      { status: 503 },
    );
  }
  invalidateBreakoutCache();

  let remUniverse = filterScanUniverse(loadAllCompanies(), market, allCompanies);
  if (scope === "selection" || body.emptyMrsi === true) {
    remUniverse = applySelectionFilters(remUniverse, selection);
  }
  if (body.tickers?.length) {
    const set = new Set(body.tickers.map((t) => t.toUpperCase()));
    remUniverse = remUniverse.filter((c) => set.has(c.ticker.toUpperCase()));
  }
  if (body.emptyMrsi === true) {
    // Progress = never-attempted only (null/failed already counted done this pass).
    const attempted = mrsiAttemptedTickers();
    remUniverse = remUniverse.filter(
      (c) => !attempted.has(c.ticker.toUpperCase()),
    );
  }
  const remaining =
    body.emptyMrsi === true
      ? remUniverse.length
      : uncheckedTickers(
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
    scope,
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
