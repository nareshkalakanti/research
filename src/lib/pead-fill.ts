/**
 * List-scoped PEAD scan — parallel quarters / result dates / returns fill.
 * stocks-ai style: prefer cache, Yahoo-first (skip Screener on bulk), deepen only when empty.
 */
import { loadAllCompanies } from "./db";
import { filterCompaniesByScanList } from "./scan-lists-server";
import { loadPead2Rows, type Pead2Row } from "./pead2-table";
import { refreshPeadReturns } from "./pead2-returns";
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
  upsertQuartersCache,
} from "./screener-quarters";
import { fetchQuarterlyFundamentals } from "./yahoo-quarters";
import { invalidateFundamentalsScanCache } from "./fundamentals-scan";
import { invalidateOperatingMetricsCache } from "./opm-consistency";
import { invalidateQuantBasketCache } from "./quant-basket";
import { runConcurrent, withScrapeWriteLock } from "./scrape-pool";

export type PeadFillCoverage = {
  universe: number;
  scored: number;
  incomplete: number;
  missing: number;
  pending: number;
};

const PEAD_FILL_LIMIT_MAX = 40;
const PEAD_FILL_LIMIT_DEFAULT = 32;
const PEAD_FILL_CONCURRENCY_MAX = 10;
const PEAD_FILL_CONCURRENCY_DEFAULT = 8;
/** Cap live Screener deepen per batch — stocks-ai is Yahoo-primary. */
const PEAD_FILL_SCREENER_BUDGET = 4;

function isIncomplete(row: Pead2Row): boolean {
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

/** Tickers in the list that are unscored or missing result/returns/Fwd PE/growth. */
export function pendingPeadFillTickers(opts: {
  market?: string;
  tickers?: string[];
}): string[] {
  const market = opts.market || "All";
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
  const pending: string[] = [];
  for (const c of pool) {
    const t = c.ticker.toUpperCase();
    const row = scored.get(t);
    if (!row || isIncomplete(row)) pending.push(t);
  }
  // Prefer incomplete scored boards (almost ready) before blank names.
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
}): PeadFillCoverage {
  const market = opts.market || "All";
  const pool = universeCompanies(market);
  const scoredRows = loadPead2Rows();
  const scoredInList = new Map<string, Pead2Row>();
  const poolSet = new Set(pool.map((c) => c.ticker.toUpperCase()));
  for (const r of scoredRows) {
    if (poolSet.has(r.ticker.toUpperCase())) {
      scoredInList.set(r.ticker.toUpperCase(), r);
    }
  }
  let incomplete = 0;
  for (const r of scoredInList.values()) {
    if (isIncomplete(r)) incomplete += 1;
  }
  const missing = Math.max(0, pool.length - scoredInList.size);
  const pending = incomplete + missing;
  return {
    universe: pool.length,
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
}): Promise<PeadFillResult> {
  const market = opts.market || "All";
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
  });
  const batch = pending.slice(0, limit);
  const coverageBefore = peadFillCoverage({ market });

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
  const filledRows: Pead2Row[] = [];

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
        failed += 1;
        return;
      }
      const panel = buildQuarterPanel(quarters);
      if (!panel) {
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
      filledRows.push({
        ticker,
        name: co?.name ?? ticker,
        market: mkt ?? "",
        sector: co?.sector ?? null,
        mcap_cr: co?.mcap_cr ?? null,
        price,
        cap_code: null,
        web: co?.web ?? null,
        sc: co?.sc ?? "",
        tv: co?.tv ?? "",
        pead_score: null,
        result_date: snapshot.result_date ?? null,
        pe_ratio: null,
        forward_pe: snapshot.forward_pe,
        returns_pct: null,
        daily_ret_pct: null,
        sales_yoy: snapshot.sales_yoy,
        sales_qoq: snapshot.extras?.sales_qoq ?? null,
        np_yoy: snapshot.np_yoy,
        np_qoq: snapshot.extras?.np_qoq ?? null,
        ebidt_yoy: snapshot.extras?.ebidt_yoy ?? null,
        ebidt_qoq: snapshot.extras?.ebidt_qoq ?? null,
        cf_profit: snapshot.extras?.cf_profit ?? null,
        has_tq: false,
        has_bb: false,
      });
    } catch {
      failed += 1;
    }
  });

  if (filledRows.length) {
    try {
      // Returns need result_date — best-effort; quarters already saved.
      await refreshPeadReturns(filledRows, {
        concurrency: Math.min(concurrency, 6),
      });
    } catch {
      /* ignore */
    }
  }

  invalidateOperatingMetricsCache();
  invalidateFundamentalsScanCache();
  invalidateQuantBasketCache();

  const remaining = pendingPeadFillTickers({
    market,
    tickers: opts.tickers,
  }).length;
  const coverage = peadFillCoverage({ market });

  return {
    ok: true,
    tried: batch.length,
    saved,
    failed,
    remaining,
    workers: concurrency,
    coverage,
    message: `Filled ${saved} · ${failed} failed · ${concurrency} workers · ${remaining.toLocaleString()} incomplete left`,
  };
}
