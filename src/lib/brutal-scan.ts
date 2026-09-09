/**
 * Brutal scanner — age ≥25, ROCE >15% every year, median YoY sales ≥12%,
 * median YoY EPS >12%. Screener annual tables + company_about.founded_year.
 *
 * Screener free pages typically expose ~12 FY columns (not full F10–24);
 * we require BRUTAL_YEARS consecutive annual points from that series.
 */
import { loadAllCompanies, type CompanyRow } from "./db";
import { edgeTickerSet } from "./edge";
import {
  FUND_WATCHLIST_KEYS,
  type FundFilterState,
  type FundWatchlistKey,
} from "./fund-watchlist-meta";
import { activeFundFilterSet } from "./fund-watchlists";
import { holdingsTickerSet } from "./holdings";
import { notesTickerSet } from "./notes";
import { filterCompaniesByScanList } from "./scan-lists-server";
import {
  fetchScreenerAnnual,
  markScreenerAnnualMiss,
  screenerAnnualCacheTickerSet,
  type ScreenerAnnualSeries,
} from "./screener-annual";
import { runConcurrent } from "./scrape-pool";
import { openSqliteNamed } from "./sqlite-utils";
import { capTier, type CapTier } from "./types";

import {
  companyAgeYears,
  isAgeAtLeast,
  parseAgeMin,
  parseFoundedYear,
  AGE_MIN_PRESETS,
} from "./company-age";

export {
  companyAgeYears,
  isAgeAtLeast,
  parseAgeMin,
  parseFoundedYear,
  AGE_MIN_PRESETS,
};

export const BRUTAL_MIN_AGE = 25;
export const BRUTAL_ROCE_MIN = 15;
/** Screener public annual depth is ~12 FY; classic funnel used 15. */
export const BRUTAL_YEARS = 12;
/** YoY observations from N annual points = N−1. */
export const BRUTAL_YOY_YEARS = BRUTAL_YEARS - 1;
export const BRUTAL_SALES_MEDIAN_MIN = 12;
/** Strict greater-than, matching the funnel diagram. */
export const BRUTAL_EPS_MEDIAN_MIN = 12;

export type BrutalStage =
  | "pass"
  | "age"
  | "roce"
  | "sales"
  | "eps"
  | "data"
  | "error";

export type BrutalRow = {
  ticker: string;
  market: string;
  name: string | null;
  founded_year: number | null;
  age: number | null;
  years_roce: number;
  years_sales: number;
  years_eps: number;
  min_roce: number | null;
  median_sales_yoy: number | null;
  median_eps_yoy: number | null;
  pass: boolean;
  stage: BrutalStage;
  detail: string | null;
  scanned_at: string;
};

export type BrutalSelection = {
  cap?: CapTier | "All";
  hold?: boolean;
  edge?: boolean;
  sme?: boolean;
  note?: boolean;
  ageMin?: number | null;
  age25?: boolean;
  funds?: FundFilterState;
};

export type BrutalScanResult = {
  tried: number;
  saved: number;
  passed: number;
  failed: number;
  remaining: number;
  saved_tickers: string[];
  done: boolean;
  message?: string;
};

let passCache: { at: number; set: Set<string> } | null = null;
const PASS_CACHE_MS = 30_000;

function median(vals: number[]): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 0) {
    return (s[mid - 1]! + s[mid]!) / 2;
  }
  return s[mid]!;
}

function yoyPct(latest: number, prior: number): number | null {
  if (!Number.isFinite(latest) || !Number.isFinite(prior) || prior === 0) {
    return null;
  }
  if (prior < 0) return null;
  return ((latest - prior) / Math.abs(prior)) * 100;
}

export function yoySeriesFromAnnual(
  values: Array<number | null>,
): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const cur = values[i];
    const prev = values[i - 1];
    if (cur == null || prev == null) continue;
    const y = yoyPct(cur, prev);
    if (y != null && Number.isFinite(y)) out.push(y);
  }
  return out;
}

function compactNums(vals: Array<number | null>): number[] {
  return vals.filter((v): v is number => v != null && Number.isFinite(v));
}

export function evaluateBrutal(opts: {
  foundedYear: number | null;
  series: ScreenerAnnualSeries;
  asOf?: Date;
}): Omit<BrutalRow, "ticker" | "market" | "name" | "scanned_at"> {
  const founded = opts.foundedYear;
  const age = companyAgeYears(founded, opts.asOf);
  const empty = {
    founded_year: founded,
    age,
    years_roce: 0,
    years_sales: 0,
    years_eps: 0,
    min_roce: null as number | null,
    median_sales_yoy: null as number | null,
    median_eps_yoy: null as number | null,
    pass: false,
  };

  if (age == null || age < BRUTAL_MIN_AGE) {
    return {
      ...empty,
      stage: "age",
      detail:
        age == null
          ? "Missing founded year"
          : `Age ${age} < ${BRUTAL_MIN_AGE}`,
    };
  }

  const roce = compactNums(opts.series.roce).slice(-BRUTAL_YEARS);
  const salesYoy = yoySeriesFromAnnual(opts.series.sales).slice(
    -BRUTAL_YOY_YEARS,
  );
  const epsYoy = yoySeriesFromAnnual(opts.series.eps).slice(-BRUTAL_YOY_YEARS);

  const minRoce = roce.length ? Math.min(...roce) : null;
  const medSales = median(salesYoy);
  const medEps = median(epsYoy);

  const base = {
    ...empty,
    years_roce: roce.length,
    years_sales: salesYoy.length,
    years_eps: epsYoy.length,
    min_roce: minRoce != null ? Math.round(minRoce * 100) / 100 : null,
    median_sales_yoy:
      medSales != null ? Math.round(medSales * 100) / 100 : null,
    median_eps_yoy: medEps != null ? Math.round(medEps * 100) / 100 : null,
  };

  // Need BRUTAL_YEARS ROCE points and BRUTAL_YOY_YEARS YoY observations
  // (12 annual Sales/EPS → 11 YoYs on Screener free pages).
  if (roce.length < BRUTAL_YEARS) {
    return {
      ...base,
      stage: "data",
      detail: `ROCE years ${roce.length}/${BRUTAL_YEARS}`,
    };
  }
  if (minRoce == null || !(minRoce > BRUTAL_ROCE_MIN)) {
    return {
      ...base,
      stage: "roce",
      detail: `Min ROCE ${minRoce?.toFixed(1) ?? "n/a"}% ≤ ${BRUTAL_ROCE_MIN}%`,
    };
  }

  if (salesYoy.length < BRUTAL_YOY_YEARS) {
    return {
      ...base,
      stage: "data",
      detail: `Sales YoY years ${salesYoy.length}/${BRUTAL_YOY_YEARS}`,
    };
  }
  if (medSales == null || !(medSales >= BRUTAL_SALES_MEDIAN_MIN)) {
    return {
      ...base,
      stage: "sales",
      detail: `Median sales YoY ${medSales?.toFixed(1) ?? "n/a"}% < ${BRUTAL_SALES_MEDIAN_MIN}%`,
    };
  }

  if (epsYoy.length < BRUTAL_YOY_YEARS) {
    return {
      ...base,
      stage: "data",
      detail: `EPS YoY years ${epsYoy.length}/${BRUTAL_YOY_YEARS}`,
    };
  }
  if (medEps == null || !(medEps > BRUTAL_EPS_MEDIAN_MIN)) {
    return {
      ...base,
      stage: "eps",
      detail: `Median EPS YoY ${medEps?.toFixed(1) ?? "n/a"}% ≤ ${BRUTAL_EPS_MEDIAN_MIN}%`,
    };
  }

  return {
    ...base,
    pass: true,
    stage: "pass",
    detail: null,
  };
}

function ensureDb() {
  const db = openSqliteNamed("brutal.db", { wal: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS brutal_scan (
      ticker TEXT PRIMARY KEY,
      market TEXT,
      name TEXT,
      founded_year INTEGER,
      age INTEGER,
      years_roce INTEGER NOT NULL DEFAULT 0,
      years_sales INTEGER NOT NULL DEFAULT 0,
      years_eps INTEGER NOT NULL DEFAULT 0,
      min_roce REAL,
      median_sales_yoy REAL,
      median_eps_yoy REAL,
      pass INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL,
      detail TEXT,
      scanned_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_brutal_pass ON brutal_scan(pass);
  `);
  return db;
}

export function invalidateBrutalCache(): void {
  passCache = null;
}

export function saveBrutalRow(row: BrutalRow): void {
  const db = ensureDb();
  try {
    db.prepare(
      `INSERT INTO brutal_scan (
        ticker, market, name, founded_year, age,
        years_roce, years_sales, years_eps,
        min_roce, median_sales_yoy, median_eps_yoy,
        pass, stage, detail, scanned_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ticker) DO UPDATE SET
        market=excluded.market,
        name=excluded.name,
        founded_year=excluded.founded_year,
        age=excluded.age,
        years_roce=excluded.years_roce,
        years_sales=excluded.years_sales,
        years_eps=excluded.years_eps,
        min_roce=excluded.min_roce,
        median_sales_yoy=excluded.median_sales_yoy,
        median_eps_yoy=excluded.median_eps_yoy,
        pass=excluded.pass,
        stage=excluded.stage,
        detail=excluded.detail,
        scanned_at=excluded.scanned_at`,
    ).run(
      row.ticker.toUpperCase(),
      row.market,
      row.name,
      row.founded_year,
      row.age,
      row.years_roce,
      row.years_sales,
      row.years_eps,
      row.min_roce,
      row.median_sales_yoy,
      row.median_eps_yoy,
      row.pass ? 1 : 0,
      row.stage,
      row.detail,
      row.scanned_at,
    );
  } finally {
    db.close();
  }
  invalidateBrutalCache();
}

export function brutalPassTickerSet(): Set<string> {
  const now = Date.now();
  if (passCache && now - passCache.at < PASS_CACHE_MS) return passCache.set;
  const set = new Set<string>();
  try {
    const db = openSqliteNamed("brutal.db", { readonly: true, wal: true });
    try {
      const rows = db
        .prepare(`SELECT ticker FROM brutal_scan WHERE pass = 1`)
        .all() as Array<{ ticker: string }>;
      for (const r of rows) set.add(r.ticker.toUpperCase());
    } finally {
      db.close();
    }
  } catch {
    /* missing db */
  }
  passCache = { at: now, set };
  return set;
}

export function brutalScannedTickerSet(): Set<string> {
  const set = new Set<string>();
  try {
    const db = openSqliteNamed("brutal.db", { readonly: true, wal: true });
    try {
      const rows = db
        .prepare(`SELECT ticker FROM brutal_scan`)
        .all() as Array<{ ticker: string }>;
      for (const r of rows) set.add(r.ticker.toUpperCase());
    } finally {
      db.close();
    }
  } catch {
    /* missing */
  }
  return set;
}

function applySelectionFilters<
  T extends {
    ticker: string;
    market: string;
    mcap_cr?: number | null;
    founded_year?: string | null;
  },
>(companies: T[], opts: BrutalSelection): T[] {
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

export function hasBrutalSelection(opts: BrutalSelection): boolean {
  if (opts.cap && opts.cap !== "All") return true;
  if (
    opts.hold ||
    opts.edge ||
    opts.sme ||
    opts.note ||
    opts.ageMin != null
  ) {
    return true;
  }
  return FUND_WATCHLIST_KEYS.some((k) => opts.funds?.[k as FundWatchlistKey]);
}

export function pendingBrutalTickers(opts?: {
  market?: string;
  tickers?: string[];
  selection?: BrutalSelection | null;
}): string[] {
  const all = loadAllCompanies();
  let pool = filterCompaniesByScanList(all, opts?.market || "All", all);
  if (opts?.selection && hasBrutalSelection(opts.selection)) {
    pool = applySelectionFilters(pool, opts.selection);
  }
  if (opts?.tickers?.length) {
    const want = new Set(opts.tickers.map((t) => t.toUpperCase()));
    pool = pool.filter((c) => want.has(c.ticker.toUpperCase()));
  }

  const scanned = brutalScannedTickerSet();
  const annualCached = screenerAnnualCacheTickerSet();
  const out: string[] = [];
  for (const c of pool) {
    const t = c.ticker.toUpperCase();
    if (scanned.has(t)) continue;
    // Prefer names that already have annual cache (fast) — still include rest.
    out.push(t);
  }
  out.sort((a, b) => {
    const ca = all.find((c) => c.ticker.toUpperCase() === a);
    const cb = all.find((c) => c.ticker.toUpperCase() === b);
    const ya = parseFoundedYear(ca?.founded_year) ?? 9999;
    const yb = parseFoundedYear(cb?.founded_year) ?? 9999;
    const ac = annualCached.has(a) ? 0 : 1;
    const bc = annualCached.has(b) ? 0 : 1;
    return ac - bc || ya - yb || a.localeCompare(b);
  });
  return out;
}

async function evaluateTicker(c: CompanyRow): Promise<BrutalRow> {
  const now = new Date().toISOString();
  const founded = parseFoundedYear(c.founded_year);
  const age = companyAgeYears(founded);
  const baseMeta = {
    ticker: c.ticker.toUpperCase(),
    market: c.market || "NSE",
    name: c.name || null,
    scanned_at: now,
  };

  if (age == null || age < BRUTAL_MIN_AGE) {
    return {
      ...baseMeta,
      founded_year: founded,
      age,
      years_roce: 0,
      years_sales: 0,
      years_eps: 0,
      min_roce: null,
      median_sales_yoy: null,
      median_eps_yoy: null,
      pass: false,
      stage: "age",
      detail:
        age == null
          ? "Missing founded year"
          : `Age ${age} < ${BRUTAL_MIN_AGE}`,
    };
  }

  try {
    const series = await fetchScreenerAnnual(c.ticker, {
      consolidated: true,
    });
    if (!series.dates.length) {
      markScreenerAnnualMiss(c.ticker);
      return {
        ...baseMeta,
        founded_year: founded,
        age,
        years_roce: 0,
        years_sales: 0,
        years_eps: 0,
        min_roce: null,
        median_sales_yoy: null,
        median_eps_yoy: null,
        pass: false,
        stage: "data",
        detail: "No Screener annual series",
      };
    }
    const ev = evaluateBrutal({ foundedYear: founded, series });
    return { ...baseMeta, ...ev };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ...baseMeta,
      founded_year: founded,
      age,
      years_roce: 0,
      years_sales: 0,
      years_eps: 0,
      min_roce: null,
      median_sales_yoy: null,
      median_eps_yoy: null,
      pass: false,
      stage: "error",
      detail: msg.slice(0, 240),
    };
  }
}

export async function runBrutalScanBatch(opts: {
  market?: string;
  tickers?: string[];
  selection?: BrutalSelection | null;
  limit?: number;
  concurrency?: number;
  missingOnly?: boolean;
}): Promise<BrutalScanResult> {
  // Screener is gap-throttled (~2.5s); keep batches small.
  const limit = Math.min(12, Math.max(1, opts.limit ?? 4));
  const concurrency = Math.min(2, Math.max(1, opts.concurrency ?? 1));
  const missingOnly = opts.missingOnly !== false;
  const scopeOpts = {
    market: opts.market,
    tickers: opts.tickers,
    selection: opts.selection,
  };

  const pending = missingOnly
    ? pendingBrutalTickers(scopeOpts)
    : (() => {
        const all = loadAllCompanies();
        let pool = filterCompaniesByScanList(
          all,
          opts.market || "All",
          all,
        );
        if (opts.selection && hasBrutalSelection(opts.selection)) {
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
      passed: 0,
      failed: 0,
      remaining: 0,
      saved_tickers: [],
      done: true,
      message: "Brutal scan complete for this pool",
    };
  }

  const companies = loadAllCompanies();
  const byTicker = new Map(
    companies.map((c) => [c.ticker.toUpperCase(), c] as const),
  );

  const savedTickers: string[] = [];
  let passed = 0;
  let failed = 0;

  await runConcurrent(batch, concurrency, async (ticker) => {
    const c = byTicker.get(ticker);
    if (!c) {
      failed += 1;
      return;
    }
    try {
      const row = await evaluateTicker(c);
      saveBrutalRow(row);
      savedTickers.push(ticker);
      if (row.pass) passed += 1;
      else if (row.stage === "error") failed += 1;
    } catch {
      failed += 1;
      saveBrutalRow({
        ticker,
        market: c.market || "NSE",
        name: c.name || null,
        founded_year: parseFoundedYear(c.founded_year),
        age: companyAgeYears(parseFoundedYear(c.founded_year)),
        years_roce: 0,
        years_sales: 0,
        years_eps: 0,
        min_roce: null,
        median_sales_yoy: null,
        median_eps_yoy: null,
        pass: false,
        stage: "error",
        detail: "evaluate failed",
        scanned_at: new Date().toISOString(),
      });
    }
  });

  const remaining = Math.max(0, pending.length - batch.length);
  return {
    tried: batch.length,
    saved: savedTickers.length,
    passed,
    failed,
    remaining,
    saved_tickers: savedTickers,
    done: remaining <= 0,
  };
}
