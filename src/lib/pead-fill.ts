/**
 * List-scoped PEAD scan — parallel quarters / result dates / returns fill.
 * stocks-ai style: prefer cache, Yahoo-first (skip Screener on bulk), deepen only when empty.
 */
import { loadAllCompanies } from "./db";
import { filterCompaniesByScanList } from "./scan-lists-server";
import { loadPead2Rows, type Pead2Row } from "./pead2-table";
import {
  metricsSnapshotFromPanel,
  persistQuarterMetricsSnapshot,
} from "./quarter-metrics-compute";
import {
  buildQuarterPanel,
  computeCfProfit,
} from "./quarter-panel";
import {
  loadCachedQuartersSeries,
  loadQuartersFillBlockedSet,
  markQuartersFillMiss,
  upsertQuartersCache,
} from "./screener-quarters";
import { fetchQuarterlyFundamentals } from "./yahoo-quarters";
import { invalidateFundamentalsScanCache } from "./fundamentals-scan";
import { invalidateOperatingMetricsCache } from "./opm-consistency";
import { invalidateQuantBasketCache } from "./quant-basket";
import { runConcurrent, withScrapeWriteLock } from "./scrape-pool";
import {
  parsePeadSeasonParam,
  peadSeasonBounds,
  resultDateInPeadSeason,
  type PeadSeasonId,
} from "./pead-season";

export type PeadFillCoverage = {
  universe: number;
  scored: number;
  incomplete: number;
  missing: number;
  pending: number;
};

const PEAD_FILL_LIMIT_MAX = 24;
const PEAD_FILL_LIMIT_DEFAULT = 16;
const PEAD_FILL_CONCURRENCY_MAX = 8;
const PEAD_FILL_CONCURRENCY_DEFAULT = 6;
/** Cap live Screener deepen per batch — stocks-ai is Yahoo-primary. */
const PEAD_FILL_SCREENER_BUDGET = 2;

/** UI “Incomplete” filter — includes announce/returns gaps Scan cannot invent. */
export function isPeadRowIncomplete(row: Pead2Row): boolean {
  if (!row.result_date) return true;
  if (row.returns_pct == null) return true;
  if (row.forward_pe == null) return true;
  if (
    row.sales_yoy == null &&
    row.np_yoy == null &&
    row.ebidt_yoy == null
  ) {
    return true;
  }
  return false;
}

/**
 * Gaps Scan Incomplete can actually fill (quarters → Fwd PE / growth).
 * Announce-date / returns-only holes belong to Refresh Returns, not this count.
 */
function needsQuarterMetricsFill(row: Pead2Row): boolean {
  if (row.forward_pe == null) return true;
  if (
    row.sales_yoy == null &&
    row.np_yoy == null &&
    row.ebidt_yoy == null
  ) {
    return true;
  }
  return false;
}

function universeCompanies(market: string) {
  const all = loadAllCompanies();
  return filterCompaniesByScanList(all, market || "All", all);
}

function missingSalesOrProfit(
  quarters: Array<{
    revenue?: number | null;
    netIncome?: number | null;
  }>,
): boolean {
  if (!quarters.length) return true;
  const latest = quarters[quarters.length - 1];
  return (
    latest?.revenue == null ||
    !Number.isFinite(latest.revenue) ||
    latest?.netIncome == null ||
    !Number.isFinite(latest.netIncome)
  );
}

function seasonOpts(raw?: string | PeadSeasonId | null) {
  return peadSeasonBounds(parsePeadSeasonParam(raw ?? "current"));
}

/**
 * Tickers Scan can fill. When a season is set (default current Oct–Dec etc.),
 * only boards whose result_date falls in that window — skips stale May prints.
 */
export function pendingPeadFillTickers(opts: {
  market?: string;
  tickers?: string[];
  season?: string | PeadSeasonId | null;
}): string[] {
  const market = opts.market || "All";
  const season = seasonOpts(opts.season);
  let pool = universeCompanies(market);
  if (opts.tickers?.length) {
    const want = new Set(
      opts.tickers.map((t) => t.trim().toUpperCase()).filter(Boolean),
    );
    pool = pool.filter((c) => want.has(c.ticker.toUpperCase()));
  }
  const scored = new Map(
    loadPead2Rows().map((r) => [r.ticker.toUpperCase(), r] as const),
  );
  const blocked = loadQuartersFillBlockedSet();
  const pending: string[] = [];
  for (const c of pool) {
    const t = c.ticker.toUpperCase();
    if (blocked.has(t)) continue;
    const row = scored.get(t);
    if (row) {
      if (
        (season.from || season.to) &&
        !resultDateInPeadSeason(row.result_date, season)
      ) {
        continue;
      }
      if (needsQuarterMetricsFill(row)) pending.push(t);
      continue;
    }
    // Unscored: only when All dates — season scan stays on known prints.
    if (season.id === "all") pending.push(t);
  }
  // Prefer scored boards missing PE/growth (almost ready) before blank names.
  pending.sort((a, b) => {
    const ar = scored.get(a);
    const br = scored.get(b);
    if (!!ar !== !!br) return ar ? -1 : 1;
    const as = ar?.pead_score ?? -1;
    const bs = br?.pead_score ?? -1;
    if (as !== bs) return bs - as;
    return a.localeCompare(b);
  });
  return pending;
}

export function peadFillCoverage(opts: {
  market?: string;
  season?: string | PeadSeasonId | null;
}): PeadFillCoverage {
  const market = opts.market || "All";
  const season = seasonOpts(opts.season);
  const pool = universeCompanies(market);
  const scoredRows = loadPead2Rows();
  const scoredInList = new Map<string, Pead2Row>();
  const poolSet = new Set(pool.map((c) => c.ticker.toUpperCase()));
  for (const r of scoredRows) {
    if (!poolSet.has(r.ticker.toUpperCase())) continue;
    if (season.from || season.to) {
      if (!resultDateInPeadSeason(r.result_date, season)) continue;
    }
    scoredInList.set(r.ticker.toUpperCase(), r);
  }
  const blocked = loadQuartersFillBlockedSet();
  let incomplete = 0;
  for (const r of scoredInList.values()) {
    const t = r.ticker.toUpperCase();
    if (blocked.has(t)) continue;
    if (needsQuarterMetricsFill(r)) incomplete += 1;
  }
  let missing = 0;
  if (season.id === "all") {
    const anyScored = new Set(scoredRows.map((r) => r.ticker.toUpperCase()));
    for (const c of pool) {
      const t = c.ticker.toUpperCase();
      if (anyScored.has(t) || blocked.has(t)) continue;
      missing += 1;
    }
  }
  const pending = incomplete + missing;
  return {
    universe: season.id === "all" ? pool.length : scoredInList.size,
    scored: scoredInList.size,
    incomplete,
    missing,
    pending,
  };
}

export type PeadFillResult = {
  ok: true;
  tried: number;
  saved: number;
  failed: number;
  remaining: number;
  workers: number;
  coverage: PeadFillCoverage;
  message?: string;
};

export async function runPeadFillBatch(opts: {
  market?: string;
  tickers?: string[];
  limit?: number;
  concurrency?: number;
  season?: string | PeadSeasonId | null;
}): Promise<PeadFillResult> {
  const market = opts.market || "All";
  const season = opts.season ?? "current";
  const limit = Math.min(
    PEAD_FILL_LIMIT_MAX,
    Math.max(1, opts.limit ?? PEAD_FILL_LIMIT_DEFAULT),
  );
  const concurrency = Math.min(
    PEAD_FILL_CONCURRENCY_MAX,
    Math.max(1, opts.concurrency ?? PEAD_FILL_CONCURRENCY_DEFAULT),
  );
  const pending = pendingPeadFillTickers({
    market,
    tickers: opts.tickers,
    season,
  });
  const batch = pending.slice(0, limit);
  const coverageBefore = peadFillCoverage({ market, season });

  if (!batch.length) {
    return {
      ok: true,
      tried: 0,
      saved: 0,
      failed: 0,
      remaining: 0,
      workers: concurrency,
      coverage: coverageBefore,
      message: "PEAD coverage complete for this list",
    };
  }

  const companies = loadAllCompanies();
  const byTicker = new Map(
    companies.map((c) => [c.ticker.toUpperCase(), c] as const),
  );

  let saved = 0;
  let failed = 0;
  let screenerBudget = PEAD_FILL_SCREENER_BUDGET;

  await runConcurrent(batch, concurrency, async (ticker) => {
    const co = byTicker.get(ticker);
    const mkt = co?.market ?? null;
    try {
      // 1) Reuse any usable cached series (stocks-ai cache-first).
      let quarters = loadCachedQuartersSeries(ticker) ?? [];
      let price = co?.price ?? null;
      let operating_cashflow: number | null = null;
      let operating_cashflow_np: number | null = null;

      // 2) stocks-ai style: Yahoo first, skip Screener on bulk.
      if (quarters.length < 2 || missingSalesOrProfit(quarters)) {
        const live = await fetchQuarterlyFundamentals(ticker, mkt, {
          skipChart: true,
          skipScreener: true,
          screenerForce: false,
          yahooFirst: true,
        });
        if (live.quarters.length >= 2) {
          quarters = live.quarters;
          price = co?.price ?? live.price ?? price;
          operating_cashflow = live.operating_cashflow;
          operating_cashflow_np = live.operating_cashflow_np;
        }
      }

      // 3) Screener deepen only when still empty — budgeted per batch.
      if (quarters.length < 2 && screenerBudget > 0) {
        screenerBudget -= 1;
        const deep = await fetchQuarterlyFundamentals(ticker, mkt, {
          skipChart: true,
          skipScreener: false,
          screenerForce: true,
          yahooFirst: true,
        });
        if (deep.quarters.length >= 2) {
          quarters = deep.quarters;
          price = co?.price ?? deep.price ?? price;
          operating_cashflow = deep.operating_cashflow;
          operating_cashflow_np = deep.operating_cashflow_np;
        }
      }

      if (quarters.length < 2) {
        markQuartersFillMiss(ticker);
        failed += 1;
        return;
      }
      const panel = buildQuarterPanel(quarters);
      if (!panel) {
        markQuartersFillMiss(ticker);
        failed += 1;
        return;
      }
      const latestNp = quarters[quarters.length - 1]?.netIncome ?? null;
      const snapshot = metricsSnapshotFromPanel(
        panel,
        price,
        computeCfProfit(operating_cashflow, operating_cashflow_np ?? latestNp),
        quarters.at(-1)?.date ?? null,
        quarters,
      );
      await withScrapeWriteLock(() => {
        upsertQuartersCache(ticker, quarters);
        persistQuarterMetricsSnapshot(ticker, snapshot);
      });
      saved += 1;
    } catch {
      markQuartersFillMiss(ticker);
      failed += 1;
    }
  });

  // Announce dates + returns are Refresh Returns — keep Scan on quarters only.

  invalidateOperatingMetricsCache();
  invalidateFundamentalsScanCache();
  invalidateQuantBasketCache();

  const remaining = pendingPeadFillTickers({
    market,
    tickers: opts.tickers,
    season,
  }).length;
  const coverage = peadFillCoverage({ market, season });

  return {
    ok: true,
    tried: batch.length,
    saved,
    failed,
    remaining,
    workers: concurrency,
    coverage,
    message: `Filled ${saved} · ${failed} miss · ${concurrency} workers · ${remaining.toLocaleString()} left · use Refresh Returns for announce/%`,
  };
}
