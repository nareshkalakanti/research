/**
 * List-scoped PEAD scan — parallel quarters / result dates / returns fill.
 * stocks-ai style: prefer cache, Yahoo-first (skip Screener on bulk), deepen only when empty.
 */
import { loadAllCompanies } from "./db";
import { filterCompaniesByScanList } from "./scan-lists-server";
import {
  invalidatePead2TableCache,
  loadPead2Rows,
  type Pead2Row,
} from "./pead2-table";
import {
  metricsSnapshotFromPanel,
  persistQuarterMetricsSnapshot,
} from "./quarter-metrics-compute";
import {
  buildQuarterPanel,
  computeCfProfit,
  mergeQuarterFill,
  yoyFromPanel,
} from "./quarter-panel";
import { loadQuarterMetricsMap } from "./quarter-metrics-cache";
import { usableAnnounceResultDate } from "./pead-announced";
import {
  loadCachedQuartersSeries,
  loadQuartersFillBlockedSet,
  markQuartersFillMiss,
  upsertQuartersCache,
} from "./screener-quarters";
import { fetchGrowwQuarterlyFundamentals } from "./groww-quarters";
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
/** Cap Groww tip-deepen per batch (Screener blocks — do not live-hit it here). */
const PEAD_FILL_GROWW_BUDGET = 8;

function hasGrowthMetrics(row: Pead2Row): boolean {
  return (
    row.sales_yoy != null || row.np_yoy != null || row.ebidt_yoy != null
  );
}

/** Snapshot already tried FPE (incl. 999 loss / unusable run-rate). */
function hasResolvedForwardPeSnapshot(ticker: string): boolean {
  const q = loadQuarterMetricsMap().get(ticker.toUpperCase());
  return q != null && q.forward_pe != null && Number.isFinite(q.forward_pe);
}

/** UI “Incomplete” — returns/date gaps (Refresh Returns), not permanent loss-PE. */
export function isPeadRowIncomplete(row: Pead2Row): boolean {
  if (!row.result_date) return true;
  if (row.returns_pct == null) return true;
  if (row.forward_pe != null || hasGrowthMetrics(row)) return false;
  if (hasResolvedForwardPeSnapshot(row.ticker)) return false;
  const cached = loadCachedQuartersSeries(row.ticker);
  if (cached && cached.length >= 2) return false;
  return true;
}

/**
 * Gaps Scan Incomplete can fill. Do not loop forever on loss-makers (FPE 999)
 * or names whose quarters are already cached but have no YoY anchor.
 */
function needsQuarterMetricsFill(row: Pead2Row): boolean {
  const hasFpe = row.forward_pe != null;
  const growth = hasGrowthMetrics(row);
  if (hasFpe && growth) return false;
  if (!hasFpe && hasResolvedForwardPeSnapshot(row.ticker) && growth) {
    return false;
  }
  if (hasFpe && !growth) {
    const cached = loadCachedQuartersSeries(row.ticker);
    // Quarters present but no YoY pair (gaps / short history) — Scan cannot invent.
    if (cached && cached.length >= 2) return false;
  }
  if (!hasFpe && !growth) {
    if (hasResolvedForwardPeSnapshot(row.ticker)) {
      const cached = loadCachedQuartersSeries(row.ticker);
      if (cached && cached.length >= 2) return false;
    }
  }
  return true;
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
  // Explicit tickers = force tip refresh (stale Yahoo tip still "complete").
  // Bulk Scan Incomplete keeps the pending filter.
  const blocked = loadQuartersFillBlockedSet();
  const forced = (opts.tickers ?? [])
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t && !blocked.has(t));
  const pending = forced.length
    ? forced
    : pendingPeadFillTickers({
        market,
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
  let growwBudget = PEAD_FILL_GROWW_BUDGET;

  await runConcurrent(batch, concurrency, async (ticker) => {
    const co = byTicker.get(ticker);
    const mkt = co?.market ?? null;
    try {
      // 1) Reuse any usable cached series (stocks-ai cache-first).
      let quarters = loadCachedQuartersSeries(ticker) ?? [];
      let price = co?.price ?? null;
      let operating_cashflow: number | null = null;
      let operating_cashflow_np: number | null = null;

      // 2) Yahoo-first + Groww tip (skip Screener — host blocks). Always
      // refresh pending fills so a stale Yahoo tip (e.g. Jun) can pick up
      // Groww's newer quarter (e.g. Sep).
      {
        const live = await fetchQuarterlyFundamentals(ticker, mkt, {
          skipChart: true,
          skipScreener: true,
          screenerForce: false,
          yahooFirst: true,
        });
        if (live.quarters.length) {
          // Live wins on overlap — stale cache must not block tip/PnL repair.
          const merged = mergeQuarterFill(live.quarters, quarters);
          if (merged.length >= 2) {
            quarters = merged;
            price = co?.price ?? live.price ?? price;
            operating_cashflow = live.operating_cashflow;
            operating_cashflow_np = live.operating_cashflow_np;
          }
        }
      }

      // 3) Groww deepen when empty or no YoY (Screener deepen removed).
      let panel =
        quarters.length >= 2 ? buildQuarterPanel(quarters) : null;
      const yoy = panel ? yoyFromPanel(panel) : null;
      const needYoY =
        yoy?.sales_yoy == null &&
        yoy?.np_yoy == null &&
        yoy?.ebidt_yoy == null;
      if ((quarters.length < 2 || needYoY) && growwBudget > 0) {
        growwBudget -= 1;
        const groww = await fetchGrowwQuarterlyFundamentals(
          ticker,
          co?.name ?? null,
        );
        if (groww.length) {
          const merged = mergeQuarterFill(groww, quarters);
          if (merged.length >= 2) {
            quarters = merged;
            panel = buildQuarterPanel(quarters);
          }
        }
      }

      if (quarters.length < 2) {
        markQuartersFillMiss(ticker);
        failed += 1;
        return;
      }
      if (!panel) panel = buildQuarterPanel(quarters);
      if (!panel) {
        markQuartersFillMiss(ticker);
        failed += 1;
        return;
      }
      const latestNp = quarters[quarters.length - 1]?.netIncome ?? null;
      const priorAnnounce = usableAnnounceResultDate(
        loadQuarterMetricsMap().get(ticker)?.result_date,
      );
      const snapshot = metricsSnapshotFromPanel(
        panel,
        price,
        computeCfProfit(operating_cashflow, operating_cashflow_np ?? latestNp),
        priorAnnounce,
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
  invalidatePead2TableCache();

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
