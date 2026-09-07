/**
 * Batch-fill quarterly P&L for Operating Metrics coverage (missing-only).
 */
import { loadAllCompanies } from "./db";
import { edgeTickerSet } from "./edge";
import {
  FUND_WATCHLIST_KEYS,
  type FundFilterState,
  type FundWatchlistKey,
} from "./fund-watchlist-meta";
import { activeFundFilterSet } from "./fund-watchlists";
import { holdingsTickerSet } from "./holdings";
import { notesTickerSet } from "./notes";
import { invalidateOperatingMetricsCache } from "./opm-consistency";
import { passesStableOpmScreen } from "./opm-math";
import { filterCompaniesByScanList } from "./scan-lists-server";
import { runConcurrent } from "./scrape-pool";
import {
  markQuartersFillMiss,
  quartersCacheTickerSet,
  upsertQuartersCache,
} from "./screener-quarters";
import { qualityTickerSet } from "./quality";
import { openSqliteNamed } from "./sqlite-utils";
import type { CapTier } from "./types";
import { capTier } from "./types";
import { fetchQuarterlyFundamentals } from "./yahoo-quarters";

export type QuartersFillResult = {
  tried: number;
  saved: number;
  failed: number;
  remaining: number;
  saved_tickers: string[];
  done: boolean;
  message?: string;
};

export type QuartersFillSelection = {
  cap?: CapTier | "All";
  hold?: boolean;
  edge?: boolean;
  quality?: boolean;
  sme?: boolean;
  note?: boolean;
  funds?: FundFilterState;
};

function cachedQuartersUsableMap(): Map<
  string,
  { usable: number; blocked: boolean }
> {
  const out = new Map<string, { usable: number; blocked: boolean }>();
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const rows = db
        .prepare(
          `SELECT ticker, quarters_json, blocked_until FROM screener_quarters_cache`,
        )
        .all() as Array<{
        ticker: string;
        quarters_json: string;
        blocked_until: string | null;
      }>;
      const now = Date.now();
      for (const row of rows) {
        const t = row.ticker.toUpperCase();
        const blocked =
          !!row.blocked_until && Date.parse(row.blocked_until) > now;
        try {
          const qs = JSON.parse(row.quarters_json) as Array<{
            revenue?: number | null;
            ebit?: number | null;
          }>;
          if (!Array.isArray(qs)) {
            out.set(t, { usable: 0, blocked });
            continue;
          }
          out.set(t, {
            usable: passesStableOpmScreen(qs).usable,
            blocked,
          });
        } catch {
          out.set(t, { usable: 0, blocked });
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* metrics.db missing */
  }
  return out;
}

function applySelectionFilters<
  T extends { ticker: string; market: string; mcap_cr?: number | null },
>(companies: T[], opts: QuartersFillSelection): T[] {
  let out = companies;
  if (opts.cap && opts.cap !== "All") {
    out = out.filter((c) => capTier(c.mcap_cr ?? null) === opts.cap);
  }
  if (opts.sme) {
    out = out.filter((c) => /\bSME\b/i.test(c.market));
  }
  if (opts.hold) {
    const holdings = holdingsTickerSet();
    out = out.filter((c) => holdings.has(c.ticker.toUpperCase()));
  }
  if (opts.edge) {
    const edge = edgeTickerSet();
    out = out.filter((c) => edge.has(c.ticker.toUpperCase()));
  }
  if (opts.quality) {
    const quality = qualityTickerSet();
    out = out.filter((c) => quality.has(c.ticker.toUpperCase()));
  }
  const fundFilter = activeFundFilterSet(opts.funds ?? {});
  if (fundFilter) {
    out = out.filter((c) => fundFilter.has(c.ticker.toUpperCase()));
  }
  if (opts.note) {
    const notes = notesTickerSet();
    out = out.filter((c) => notes.has(c.ticker.toUpperCase()));
  }
  return out;
}

export function hasQuartersFillSelection(opts: QuartersFillSelection): boolean {
  if (opts.cap && opts.cap !== "All") return true;
  if (
    opts.hold ||
    opts.edge ||
    opts.quality ||
    opts.sme ||
    opts.note
  )
    return true;
  return FUND_WATCHLIST_KEYS.some(
    (k) => opts.funds?.[k as FundWatchlistKey],
  );
}

/** Tickers missing usable OPM history (need fill). */
export function pendingQuartersFillTickers(opts?: {
  market?: string;
  tickers?: string[];
  selection?: QuartersFillSelection | null;
}): string[] {
  const all = loadAllCompanies();
  let pool = filterCompaniesByScanList(
    all,
    opts?.market || "All",
    all,
  );
  if (opts?.selection && hasQuartersFillSelection(opts.selection)) {
    pool = applySelectionFilters(pool, opts.selection);
  }
  if (opts?.tickers?.length) {
    const want = new Set(opts.tickers.map((t) => t.toUpperCase()));
    pool = pool.filter((c) => want.has(c.ticker.toUpperCase()));
  }

  const cached = quartersCacheTickerSet();
  const usableByTicker = cachedQuartersUsableMap();
  const out: string[] = [];
  for (const c of pool) {
    const t = c.ticker.toUpperCase();
    const meta = usableByTicker.get(t);
    // Recently missed / blocked — don't spin Fill Quarters forever.
    if (meta?.blocked) continue;
    if (!cached.has(t)) {
      out.push(t);
      continue;
    }
    // Cached but thin — still need a refill for OPM.
    if ((meta?.usable ?? 0) < 2) out.push(t);
  }
  return out.sort();
}

export async function runQuartersFillBatch(opts: {
  market?: string;
  tickers?: string[];
  selection?: QuartersFillSelection | null;
  limit?: number;
  concurrency?: number;
  missingOnly?: boolean;
}): Promise<QuartersFillResult> {
  const limit = Math.min(24, Math.max(1, opts.limit ?? 12));
  const concurrency = Math.min(4, Math.max(1, opts.concurrency ?? 2));
  const missingOnly = opts.missingOnly !== false;
  const scopeOpts = {
    market: opts.market,
    tickers: opts.tickers,
    selection: opts.selection,
  };

  const pending = missingOnly
    ? pendingQuartersFillTickers(scopeOpts)
    : (() => {
        const all = loadAllCompanies();
        let pool = filterCompaniesByScanList(
          all,
          opts.market || "All",
          all,
        );
        if (opts.selection && hasQuartersFillSelection(opts.selection)) {
          pool = applySelectionFilters(pool, opts.selection);
        }
        if (opts.tickers?.length) {
          const want = new Set(opts.tickers.map((t) => t.toUpperCase()));
          pool = pool.filter((c) => want.has(c.ticker.toUpperCase()));
        }
        return pool.map((c) => c.ticker.toUpperCase()).sort();
      })();

  const batch = pending.slice(0, limit);
  if (!batch.length) {
    return {
      tried: 0,
      saved: 0,
      failed: 0,
      remaining: 0,
      saved_tickers: [],
      done: true,
      message: "Quarters coverage complete for this pool",
    };
  }

  const companies = loadAllCompanies();
  const marketByTicker = new Map(
    companies.map((c) => [c.ticker.toUpperCase(), c.market]),
  );

  const savedTickers: string[] = [];
  let failed = 0;
  // At most 2 live Screener page fetches per batch (2.5s gap each) — rest Yahoo/NSE/BSE.
  let screenerBudget = 2;

  await runConcurrent(batch, concurrency, async (ticker) => {
    try {
      const market = marketByTicker.get(ticker) ?? null;
      let live = await fetchQuarterlyFundamentals(ticker, market, {
        skipChart: true,
        screenerForce: false,
        skipScreener: true,
      });
      if (live.quarters.length < 2 && screenerBudget > 0) {
        screenerBudget -= 1;
        live = await fetchQuarterlyFundamentals(ticker, market, {
          skipChart: true,
          screenerForce: false,
          skipScreener: false,
        });
      }
      if (live.quarters.length >= 2) {
        upsertQuartersCache(ticker, live.quarters);
        savedTickers.push(ticker);
      } else {
        markQuartersFillMiss(ticker);
        failed += 1;
      }
    } catch {
      markQuartersFillMiss(ticker);
      failed += 1;
    }
  });

  invalidateOperatingMetricsCache();

  const remaining = pendingQuartersFillTickers(scopeOpts).length;

  return {
    tried: batch.length,
    saved: savedTickers.length,
    failed,
    remaining,
    saved_tickers: savedTickers,
    done: remaining === 0,
    message: `Filled ${savedTickers.length} · ${failed} failed · ${remaining.toLocaleString()} left`,
  };
}
