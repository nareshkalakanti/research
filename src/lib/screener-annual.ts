/**
 * Screener.in annual P&L + ratios (Sales, EPS, ROCE %) for Brutal scanner.
 */
import * as cheerio from "cheerio";
import { fetchScreenerCompanyHtml, stockBlockedUntil } from "./screener-fetch";
import { openSqliteNamed } from "./sqlite-utils";

const CACHE_MS = 14 * 24 * 60 * 60 * 1000;
const BLOCK_MS = 6 * 60 * 60 * 1000;

export type ScreenerAnnualSeries = {
  dates: string[];
  sales: Array<number | null>;
  eps: Array<number | null>;
  roce: Array<number | null>;
};

/** Richer annual P&L for Valuation Tool (subset of Screener profit-loss). */
export type ScreenerAnnualPl = {
  dates: string[];
  revenue: Array<number | null>;
  expenses: Array<number | null>;
  operating_profit: Array<number | null>;
  other_income: Array<number | null>;
  interest: Array<number | null>;
  depreciation: Array<number | null>;
  pbt: Array<number | null>;
  tax: Array<number | null>;
  pat: Array<number | null>;
  shares_cr: Array<number | null>;
  eps: Array<number | null>;
};

type CacheRow = {
  annual_json: string;
  fetched_at: string;
  blocked_until: string | null;
};

function ensureCacheSchema(): void {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS screener_annual_cache (
        ticker TEXT PRIMARY KEY,
        annual_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        blocked_until TEXT
      );
      CREATE TABLE IF NOT EXISTS screener_page_tried (
        ticker TEXT PRIMARY KEY,
        tried_at TEXT NOT NULL,
        got_annual INTEGER NOT NULL,
        got_bs INTEGER NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}

function readCache(
  ticker: string,
  opts?: { allowExpired?: boolean },
): ScreenerAnnualSeries | "blocked" | null {
  ensureCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const row = db
      .prepare(
        `SELECT annual_json, fetched_at, blocked_until FROM screener_annual_cache WHERE ticker = ?`,
      )
      .get(ticker.toUpperCase()) as CacheRow | undefined;
    if (!row) return null;
    if (row.blocked_until && Date.parse(row.blocked_until) > Date.now()) {
      return "blocked";
    }
    if (
      opts?.allowExpired ||
      Date.now() - Date.parse(row.fetched_at) < CACHE_MS
    ) {
      return JSON.parse(row.annual_json) as ScreenerAnnualSeries;
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * Young companies only have a few years on Screener: a short cached series is
 * still the full answer when it was fetched recently — don't refetch it on
 * every read (that made one stock take ~10 s each time).
 */
const SHORT_OK_MS = 7 * 86_400_000;
function fetchedWithin(table: string, ticker: string, ms: number): boolean {
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const r = db.prepare(`SELECT fetched_at FROM ${table} WHERE ticker = ?`).get(ticker.toUpperCase()) as
        | { fetched_at: string }
        | undefined;
      return !!r && Date.now() - Date.parse(r.fetched_at) < ms;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function writeCache(
  ticker: string,
  series: ScreenerAnnualSeries,
  blockedUntil?: string | null,
): void {
  ensureCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO screener_annual_cache (ticker, annual_json, fetched_at, blocked_until)
       VALUES (@ticker, @annual_json, @fetched_at, @blocked_until)
       ON CONFLICT(ticker) DO UPDATE SET
         annual_json = excluded.annual_json,
         fetched_at = excluded.fetched_at,
         blocked_until = excluded.blocked_until`,
    ).run({
      ticker: ticker.toUpperCase(),
      annual_json: JSON.stringify(series),
      fetched_at: new Date().toISOString(),
      blocked_until: blockedUntil ?? null,
    });
  } finally {
    db.close();
  }
}

export function markScreenerAnnualMiss(ticker: string): void {
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  writeCache(
    ticker,
    { dates: [], sales: [], eps: [], roce: [] },
    until,
  );
}

export function roceYoYDeltaPp(series: ScreenerAnnualSeries): number | null {
  const pairs: number[] = [];
  const n = Math.min(series.dates.length, series.roce.length);
  for (let i = 0; i < n; i++) {
    const v = series.roce[i];
    if (v == null || !Number.isFinite(v)) continue;
    pairs.push(v);
  }
  if (pairs.length < 2) return null;
  const prior = pairs[pairs.length - 2]!;
  const latest = pairs[pairs.length - 1]!;
  return Math.round((latest - prior) * 100) / 100;
}

let roceDeltaCache: { at: number; map: Map<string, number> } | null = null;
const ROCE_DELTA_CACHE_MS = 60_000;

export function loadRoceDeltaMap(): Map<string, number> {
  const now = Date.now();
  if (roceDeltaCache && now - roceDeltaCache.at < ROCE_DELTA_CACHE_MS) {
    return roceDeltaCache.map;
  }
  const map = new Map<string, number>();
  try {
    ensureCacheSchema();
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const rows = db
        .prepare(`SELECT ticker, annual_json FROM screener_annual_cache`)
        .all() as Array<{ ticker: string; annual_json: string }>;
      for (const row of rows) {
        let series: ScreenerAnnualSeries;
        try {
          series = JSON.parse(row.annual_json) as ScreenerAnnualSeries;
        } catch {
          continue;
        }
        const d = roceYoYDeltaPp(series);
        if (d != null) map.set(row.ticker.toUpperCase(), d);
      }
    } finally {
      db.close();
    }
  } catch {
    /* metrics.db missing */
  }
  roceDeltaCache = { at: now, map };
  return map;
}

export function screenerAnnualCacheTickerSet(): Set<string> {
  ensureCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const rows = db
      .prepare(`SELECT ticker FROM screener_annual_cache`)
      .all() as Array<{ ticker: string }>;
    return new Set(rows.map((r) => r.ticker.toUpperCase()));
  } finally {
    db.close();
  }
}

function parseNum(raw: string): number | null {
  const t = raw
    .replace(/\u00a0/g, " ")
    .replace(/,/g, "")
    .replace(/%/g, "")
    .trim();
  if (!t || t === "-" || t === "—") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

type CheerioLoaded = ReturnType<typeof cheerio.load>;

export function parseScreenerSectionTable(
  $: CheerioLoaded,
  sectionId: string,
  /** Fewest date columns accepted (annual tables need 2; a new listing's shareholding has 1). */
  minCols = 2,
): { dates: string[]; rows: Map<string, Array<number | null>> } | null {
  const section = $(`#${sectionId}`);
  if (!section.length) return null;
  const table = section.find("table.data-table").first().length
    ? section.find("table.data-table").first()
    : section.find("table").first();
  if (!table.length) return null;

  const dates: string[] = [];
  const dateIdx: number[] = [];
  table.find("thead th").each((idx, th) => {
    if (idx === 0) return;
    const key = ($(th).attr("data-date-key") || "").trim();
    const label = $(th).text().replace(/\s+/g, " ").trim();
    if (/^TTM$/i.test(label) || /^TTM$/i.test(key)) return;
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      dates.push(key);
      dateIdx.push(idx);
      return;
    }
    const m = label.match(/([A-Za-z]{3})\s+(\d{4})/);
    if (m) {
      const mon = m[1]!.toUpperCase();
      const monthMap: Record<string, string> = {
        JAN: "01",
        FEB: "02",
        MAR: "03",
        APR: "04",
        MAY: "05",
        JUN: "06",
        JUL: "07",
        AUG: "08",
        SEP: "09",
        OCT: "10",
        NOV: "11",
        DEC: "12",
      };
      const mm = monthMap[mon];
      if (mm) {
        dates.push(`${m[2]}-${mm}-01`);
        dateIdx.push(idx);
      }
    }
  });
  if (dates.length < minCols) return null;

  const rows = new Map<string, Array<number | null>>();
  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td, th");
    if (cells.length < 2) return;
    // Keep button text (Screener often puts "Sales" inside the + control).
    const name = $(cells[0])
      .text()
      .replace(/\u00a0/g, " ")
      .replace(/\+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!name) return;
    const vals: Array<number | null> = [];
    for (const idx of dateIdx) {
      const cell = $(cells[idx]).clone();
      cell.find("button, .button, svg").remove();
      vals.push(parseNum(cell.text()));
    }
    rows.set(name, vals);
  });

  return { dates, rows };
}

export function pickScreenerRow(
  rows: Map<string, Array<number | null>>,
  patterns: RegExp[],
  opts?: { allowPct?: boolean },
): Array<number | null> | null {
  for (const re of patterns) {
    for (const [name, vals] of rows) {
      if (!re.test(name)) continue;
      if (
        !opts?.allowPct &&
        /growth|yoy|qoq|\b%\s*$/i.test(name) &&
        !/^OPM\b/i.test(name)
      ) {
        continue;
      }
      return vals;
    }
  }
  return null;
}

function zipAdd(
  a: Array<number | null> | null,
  b: Array<number | null> | null,
  n: number,
): Array<number | null> | null {
  if (!a || !b) return null;
  const out: Array<number | null> = [];
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    out.push(x != null && y != null ? x + y : null);
  }
  return out.some((v) => v != null) ? out : null;
}

/** Parse annual Sales / EPS / ROCE from Screener company HTML. */
export function parseScreenerAnnualHtml(html: string): ScreenerAnnualSeries {
  const empty: ScreenerAnnualSeries = {
    dates: [],
    sales: [],
    eps: [],
    roce: [],
  };
  if (/captcha|access denied|rate limit/i.test(html)) return empty;

  const $ = cheerio.load(html);
  const pl = parseScreenerSectionTable($, "profit-loss");
  const ratios = parseScreenerSectionTable($, "ratios");
  if (!pl && !ratios) return empty;

  const dates = pl?.dates ?? ratios?.dates ?? [];
  const sales = pl
    ? pickScreenerRow(pl.rows, [
        /^Sales\b/i,
        /^Net Sales\b/i,
        /^Revenue from operations/i,
        /^Revenue\b/i,
      ])
    : null;
  const eps = pl
    ? pickScreenerRow(pl.rows, [/^EPS\b/i, /EPS in Rs/i])
    : null;
  const roce = ratios
    ? pickScreenerRow(ratios.rows, [/^ROCE\b/i])
    : null;

  // Align lengths to dates; prefer P&L date axis.
  const n = dates.length;
  return {
    dates,
    sales: (sales ?? Array(n).fill(null)).slice(0, n),
    eps: (eps ?? Array(n).fill(null)).slice(0, n),
    roce: (() => {
      if (!roce || !ratios) return Array(n).fill(null);
      if (!pl || ratios.dates.join() === pl.dates.join()) {
        return roce.slice(0, n);
      }
      // Map ratio dates onto P&L dates by year.
      const byYear = new Map<string, number | null>();
      ratios.dates.forEach((d, i) => {
        byYear.set(d.slice(0, 4), roce[i] ?? null);
      });
      return dates.map((d) => byYear.get(d.slice(0, 4)) ?? null);
    })(),
  };
}

function alignRow(
  n: number,
  vals: Array<number | null> | null,
): Array<number | null> {
  return (vals ?? Array(n).fill(null)).slice(0, n);
}

/** Full annual P&L lines for Valuation Tool. */
export function parseScreenerAnnualPlHtml(html: string): ScreenerAnnualPl {
  const empty: ScreenerAnnualPl = {
    dates: [],
    revenue: [],
    expenses: [],
    operating_profit: [],
    other_income: [],
    interest: [],
    depreciation: [],
    pbt: [],
    tax: [],
    pat: [],
    shares_cr: [],
    eps: [],
  };
  if (/captcha|access denied|rate limit/i.test(html)) return empty;
  const $ = cheerio.load(html);
  const pl = parseScreenerSectionTable($, "profit-loss");
  if (!pl?.dates.length) return empty;
  const n = pl.dates.length;
  const revenue =
    pickScreenerRow(pl.rows, [
      /^Sales\b/i,
      /^Net Sales\b/i,
      /^Revenue from operations/i,
      /^Income from operations/i,
      /^Revenue\b/i,
    ]) ??
    zipAdd(
      pickScreenerRow(pl.rows, [/^Expenses\b/i]),
      pickScreenerRow(pl.rows, [/^Operating Profit\b/i, /^EBIT\b/i]),
      n,
    );
  const op = pickScreenerRow(pl.rows, [/^Operating Profit\b/i, /^EBIT\b/i]);
  const expenses = pickScreenerRow(pl.rows, [/^Expenses\b/i]);
  const otherIncome = pickScreenerRow(pl.rows, [/^Other Income\b/i]);
  const interest = pickScreenerRow(pl.rows, [/^Interest\b/i]);
  const depreciation = pickScreenerRow(pl.rows, [/^Depreciation\b/i]);
  const pbt = pickScreenerRow(pl.rows, [/^Profit before tax\b/i, /^PBT\b/i]);
  const tax = pickScreenerRow(pl.rows, [/^Tax\b/i, /^Tax %/i], { allowPct: true });
  let pat = pickScreenerRow(pl.rows, [
    /^Net Profit\b/i,
    /^Profit after tax\b/i,
    /^Reported (?:Net )?Profit\b/i,
    /^PAT\b/i,
  ]);
  if (!pat?.some((v) => v != null) && pbt?.some((v) => v != null) && tax) {
    pat = pbt.map((p, i) => {
      if (p == null || tax[i] == null) return null;
      const t = tax[i]!;
      const rate = Math.abs(t) <= 100 ? t / 100 : t / p;
      return p * (1 - rate);
    });
  }
  const eps = pickScreenerRow(pl.rows, [/^EPS\b/i, /EPS in Rs/i]);
  // Screener sometimes has "Equity Capital" / shares elsewhere — leave null.
  return {
    dates: pl.dates.slice(0, n),
    revenue: alignRow(n, revenue),
    expenses: alignRow(n, expenses),
    operating_profit: alignRow(n, op),
    other_income: alignRow(n, otherIncome),
    interest: alignRow(n, interest),
    depreciation: alignRow(n, depreciation),
    pbt: alignRow(n, pbt),
    tax: alignRow(n, tax),
    pat: alignRow(n, pat),
    shares_cr: Array(n).fill(null),
    eps: alignRow(n, eps),
  };
}

const PL_CACHE_MS = CACHE_MS;

function ensurePlCacheSchema(): void {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS screener_annual_pl_cache (
        ticker TEXT PRIMARY KEY,
        pl_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        blocked_until TEXT
      );
    `);
  } finally {
    db.close();
  }
}

/** True when Sales looks like a P&L line, not growth %. OP cannot exceed Sales. */
function plUsable(pl: ScreenerAnnualPl): boolean {
  if (!pl.revenue.some((s) => s != null && s > 0)) return false;
  for (let i = 0; i < pl.revenue.length; i++) {
    const r = pl.revenue[i];
    const op = pl.operating_profit[i];
    if (r != null && op != null && r > 0 && op > 0 && r + 0.5 < op) {
      return false;
    }
  }
  return true;
}

function plYearCount(pl: ScreenerAnnualPl): number {
  return pl.dates.filter(
    (_, i) => pl.revenue[i] != null || pl.eps[i] != null || pl.pat[i] != null,
  ).length;
}

/** Newest column date (ISO) of an annual series, "" when none. */
function newestDate(dates: string[]): string {
  return [...dates].sort().at(-1) ?? "";
}

/**
 * Consolidated vs standalone: when one stops more than a year before the other
 * (e.g. KAMDHENU's consolidated accounts end FY2022 after a demerger), the
 * newer one wins whatever its length. null = no clear winner on recency.
 */
function newerByYear<T extends { dates: string[] }>(a: T, b: T): T | null {
  const na = newestDate(a.dates);
  const nb = newestDate(b.dates);
  if (!na || !nb) return null;
  const gap = Date.parse(`${nb}T00:00:00Z`) - Date.parse(`${na}T00:00:00Z`);
  if (gap > 365 * 86_400_000) return b;
  if (gap < -365 * 86_400_000) return a;
  return null;
}

/** Older than this, a cached annual series is re-checked (company may have switched to standalone). */
const STALE_SERIES_MS = 548 * 86_400_000;
/** True when the newest annual column is more than ~18 months old (demerger / cons stopped). */
export function seriesStale(dates: string[]): boolean {
  const n = newestDate(dates);
  return !!n && Date.now() - Date.parse(`${n}T00:00:00Z`) > STALE_SERIES_MS;
}

/** Prefer the parse with a usable P&L and more annual columns (standalone vs consolidated). */
export function pickRicherScreenerAnnualPl(
  a: ScreenerAnnualPl,
  b: ScreenerAnnualPl,
): ScreenerAnnualPl {
  const ua = plUsable(a);
  const ub = plUsable(b);
  if (ua && !ub) return a;
  if (ub && !ua) return b;
  if (!ua && !ub) return a;
  return newerByYear(a, b) ?? (plYearCount(b) > plYearCount(a) ? b : a);
}

function seriesYearCount(s: ScreenerAnnualSeries): number {
  return s.dates.filter((_, i) => s.sales[i] != null || s.eps[i] != null).length;
}

function pickRicherScreenerAnnual(
  a: ScreenerAnnualSeries,
  b: ScreenerAnnualSeries,
): ScreenerAnnualSeries {
  const ua = a.sales.some((s) => s != null && s > 0);
  const ub = b.sales.some((s) => s != null && s > 0);
  if (ua && !ub) return a;
  if (ub && !ua) return b;
  if (!ua && !ub) return a;
  return newerByYear(a, b) ?? (seriesYearCount(b) > seriesYearCount(a) ? b : a);
}

function readPlCache(
  ticker: string,
  opts?: { allowExpired?: boolean },
): ScreenerAnnualPl | "blocked" | null {
  ensurePlCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const row = db
      .prepare(
        `SELECT pl_json, fetched_at, blocked_until FROM screener_annual_pl_cache WHERE ticker = ?`,
      )
      .get(ticker.toUpperCase()) as
      | { pl_json: string; fetched_at: string; blocked_until: string | null }
      | undefined;
    if (!row) return null;
    if (row.blocked_until && Date.parse(row.blocked_until) > Date.now()) {
      return "blocked";
    }
    if (
      opts?.allowExpired ||
      Date.now() - Date.parse(row.fetched_at) < PL_CACHE_MS
    ) {
      return JSON.parse(row.pl_json) as ScreenerAnnualPl;
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * Cached yearly P&L and balance sheet only, never a Screener fetch (expired
 * rows are fine). For re-deriving a saved score's check after a rule fix.
 */
export function cachedAnnualPlBs(ticker: string): { pl: ScreenerAnnualPl | null; bs: ScreenerAnnualBs | null } {
  const pl = readPlCache(ticker, { allowExpired: true });
  const bs = readBsCache(ticker, { allowExpired: true });
  return { pl: pl && pl !== "blocked" ? pl : null, bs: bs && bs !== "blocked" ? bs : null };
}

function writePlCache(
  ticker: string,
  series: ScreenerAnnualPl,
  blockedUntil?: string | null,
): void {
  ensurePlCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO screener_annual_pl_cache (ticker, pl_json, fetched_at, blocked_until)
       VALUES (@ticker, @pl_json, @fetched_at, @blocked_until)
       ON CONFLICT(ticker) DO UPDATE SET
         pl_json = excluded.pl_json,
         fetched_at = excluded.fetched_at,
         blocked_until = excluded.blocked_until`,
    ).run({
      ticker: ticker.toUpperCase(),
      pl_json: JSON.stringify(series),
      fetched_at: new Date().toISOString(),
      blocked_until: blockedUntil ?? null,
    });
  } finally {
    db.close();
  }
}

export async function fetchScreenerAnnualPl(
  ticker: string,
  opts?: { force?: boolean; consolidated?: boolean },
): Promise<ScreenerAnnualPl> {
  const key = ticker.trim().toUpperCase();
  const empty: ScreenerAnnualPl = {
    dates: [],
    revenue: [],
    expenses: [],
    operating_profit: [],
    other_income: [],
    interest: [],
    depreciation: [],
    pbt: [],
    tax: [],
    pat: [],
    shares_cr: [],
    eps: [],
  };
  if (!key) return empty;

  if (!opts?.force) {
    const cached = readPlCache(key);
    if (cached === "blocked") return empty;
    // Short cache is often consolidated-only; refetch so standalone years can win.
    if (
      cached &&
      plUsable(cached) &&
      !seriesStale(cached.dates) &&
      (plYearCount(cached) >= 6 || fetchedWithin("screener_annual_pl_cache", key, SHORT_OK_MS))
    ) {
      return cached;
    }
  }

  try {
    const html = await fetchScreenerCompanyHtml(key, {
      consolidated: opts?.consolidated !== false,
    });
    let series = parseScreenerAnnualPlHtml(html);
    if (opts?.consolidated !== false) {
      try {
        const standHtml = await fetchScreenerCompanyHtml(key, {
          consolidated: false,
        });
        series = pickRicherScreenerAnnualPl(
          series,
          parseScreenerAnnualPlHtml(standHtml),
        );
      } catch {
        /* keep first parse */
      }
    }
    if (plUsable(series)) {
      writePlCache(key, series);
    }
    return series;
  } catch {
    // Pause / block: keep any usable cache (even age-expired). Never write empty —
    // that used to mark the ticker blocked and wipe Portfolio scores.
    const cached = readPlCache(key, { allowExpired: true });
    if (cached && cached !== "blocked" && plUsable(cached)) return cached;
    return empty;
  }
}

export async function fetchScreenerAnnual(
  ticker: string,
  opts?: { force?: boolean; cacheOnly?: boolean; consolidated?: boolean },
): Promise<ScreenerAnnualSeries> {
  const key = ticker.trim().toUpperCase();
  if (!key) {
    return { dates: [], sales: [], eps: [], roce: [] };
  }

  if (!opts?.force) {
    const cached = readCache(key);
    if (cached === "blocked") {
      return { dates: [], sales: [], eps: [], roce: [] };
    }
    // Ignore empty / short / stale-by-date cache so standalone can still win
    // (e.g. ORIENTPPR cons ends FY2010 while standalone runs to current FY).
    if (
      cached &&
      cached.sales.some((s) => s != null && s > 0) &&
      !seriesStale(cached.dates) &&
      (seriesYearCount(cached) >= 6 || fetchedWithin("screener_annual_cache", key, SHORT_OK_MS))
    ) {
      return cached;
    }
    if (opts?.cacheOnly) {
      return cached && cached !== "blocked"
        ? cached
        : { dates: [], sales: [], eps: [], roce: [] };
    }
  }

  try {
    const html = await fetchScreenerCompanyHtml(key, {
      consolidated: opts?.consolidated !== false,
    });
    let series = parseScreenerAnnualHtml(html);
    // Standalone often has a longer annual axis than consolidated (and vice versa).
    if (opts?.consolidated !== false) {
      try {
        const standHtml = await fetchScreenerCompanyHtml(key, {
          consolidated: false,
        });
        series = pickRicherScreenerAnnual(
          series,
          parseScreenerAnnualHtml(standHtml),
        );
      } catch {
        /* keep consolidated parse */
      }
    }
    // Only cache useful series — empty miss should not poison for 14 days
    if (series.sales.some((s) => s != null && s > 0)) {
      writeCache(key, series);
    }
    return series;
  } catch {
    // Screener pause/block: serve age-expired but usable cache instead of blanking
    // Portfolio review (tickers with only old annual rows showed No data while paused).
    const cached = readCache(key, { allowExpired: true });
    if (cached && cached !== "blocked" && cached.sales.some((s) => s != null && s > 0)) {
      return cached;
    }
    return { dates: [], sales: [], eps: [], roce: [] };
  }
}

/** Balance-sheet lines for Fundamental Score (BV / net block). */
export type ScreenerAnnualBs = {
  dates: string[];
  equity_capital: Array<number | null>;
  reserves: Array<number | null>;
  /** Equity + Reserves when both present. */
  book_value: Array<number | null>;
  fixed_assets: Array<number | null>;
  borrowings: Array<number | null>;
  /** Capital work in progress (absent on caches written before it was parsed). */
  cwip?: Array<number | null>;
  /** Cash & bank / cash equivalents (₹ Cr). Optional on older cache rows. */
  cash?: Array<number | null>;
};

function emptyBs(): ScreenerAnnualBs {
  return {
    dates: [],
    equity_capital: [],
    reserves: [],
    book_value: [],
    fixed_assets: [],
    borrowings: [],
    cash: [],
  };
}

function ensureBsCacheSchema(): void {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS screener_annual_bs_cache (
        ticker TEXT PRIMARY KEY,
        bs_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        blocked_until TEXT
      );
    `);
  } finally {
    db.close();
  }
}

function readBsCache(
  ticker: string,
  opts?: { allowExpired?: boolean },
): ScreenerAnnualBs | "blocked" | null {
  ensureBsCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const row = db
      .prepare(
        `SELECT bs_json, fetched_at, blocked_until FROM screener_annual_bs_cache WHERE ticker = ?`,
      )
      .get(ticker.toUpperCase()) as
      | { bs_json: string; fetched_at: string; blocked_until: string | null }
      | undefined;
    if (!row) return null;
    if (row.blocked_until && Date.parse(row.blocked_until) > Date.now()) {
      return "blocked";
    }
    if (
      opts?.allowExpired ||
      Date.now() - Date.parse(row.fetched_at) < CACHE_MS
    ) {
      return JSON.parse(row.bs_json) as ScreenerAnnualBs;
    }
    return null;
  } finally {
    db.close();
  }
}

function writeBsCache(
  ticker: string,
  series: ScreenerAnnualBs,
  blockedUntil?: string | null,
): void {
  ensureBsCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO screener_annual_bs_cache (ticker, bs_json, fetched_at, blocked_until)
       VALUES (@ticker, @bs_json, @fetched_at, @blocked_until)
       ON CONFLICT(ticker) DO UPDATE SET
         bs_json = excluded.bs_json,
         fetched_at = excluded.fetched_at,
         blocked_until = excluded.blocked_until`,
    ).run({
      ticker: ticker.toUpperCase(),
      bs_json: JSON.stringify(series),
      fetched_at: new Date().toISOString(),
      blocked_until: blockedUntil ?? null,
    });
  } finally {
    db.close();
  }
}

export function parseScreenerAnnualBsHtml(html: string): ScreenerAnnualBs {
  const empty = emptyBs();
  if (/captcha|access denied|rate limit/i.test(html)) return empty;
  const $ = cheerio.load(html);
  const bs = parseScreenerSectionTable($, "balance-sheet");
  if (!bs?.dates.length) return empty;
  const n = bs.dates.length;
  const equity = pickScreenerRow(bs.rows, [/^Equity Capital\b/i, /^Share Capital\b/i]);
  const reserves = pickScreenerRow(bs.rows, [
    /^Reserves\b/i,
    /^Reserves and Surplus\b/i,
  ]);
  const fixed = pickScreenerRow(bs.rows, [
    /^Fixed Assets\b/i,
    /^Net Block\b/i,
    /^Property,? Plant/i,
  ]);
  const borrowings = pickScreenerRow(bs.rows, [/^Borrowings\b/i, /^Total Debt\b/i]);
  const cwip = pickScreenerRow(bs.rows, [/^CWIP\b/i, /^Capital Work in Progress\b/i]);
  const cash = pickScreenerRow(bs.rows, [
    /^Cash Equivalents\b/i,
    /^Cash and Bank\b/i,
    /^Cash & Bank\b/i,
    /^Cash and Cash Equivalents\b/i,
    /^Cash\b/i,
  ]);
  const book = zipAdd(equity, reserves, n) ?? Array(n).fill(null);
  return {
    dates: bs.dates.slice(0, n),
    equity_capital: alignRow(n, equity),
    reserves: alignRow(n, reserves),
    book_value: alignRow(n, book),
    fixed_assets: alignRow(n, fixed),
    borrowings: alignRow(n, borrowings),
    cwip: alignRow(n, cwip),
    cash: alignRow(n, cash),
  };
}

function bsUsable(bs: ScreenerAnnualBs): boolean {
  return bs.book_value.some((v) => v != null && v > 0) ||
    bs.fixed_assets.some((v) => v != null && v > 0);
}

function bsYearCount(bs: ScreenerAnnualBs): number {
  return bs.dates.filter(
    (_, i) => bs.book_value[i] != null || bs.fixed_assets[i] != null,
  ).length;
}

function pickRicherBs(a: ScreenerAnnualBs, b: ScreenerAnnualBs): ScreenerAnnualBs {
  const ua = bsUsable(a);
  const ub = bsUsable(b);
  if (ua && !ub) return a;
  if (ub && !ua) return b;
  if (!ua && !ub) return a;
  // Prefer the series whose latest FY is newer (demerger: cons may stop years ago).
  return newerByYear(a, b) ?? (bsYearCount(b) > bsYearCount(a) ? b : a);
}

export async function fetchScreenerAnnualBs(
  ticker: string,
  opts?: { force?: boolean; consolidated?: boolean },
): Promise<ScreenerAnnualBs> {
  const key = ticker.trim().toUpperCase();
  if (!key) return emptyBs();

  if (!opts?.force) {
    const cached = readBsCache(key);
    if (cached === "blocked") return emptyBs();
    if (
      cached &&
      bsUsable(cached) &&
      !seriesStale(cached.dates) &&
      (bsYearCount(cached) >= 3 || fetchedWithin("screener_annual_bs_cache", key, SHORT_OK_MS))
    ) {
      return cached;
    }
  }

  try {
    const html = await fetchScreenerCompanyHtml(key, {
      consolidated: opts?.consolidated !== false,
    });
    let series = parseScreenerAnnualBsHtml(html);
    if (opts?.consolidated !== false) {
      try {
        const standHtml = await fetchScreenerCompanyHtml(key, {
          consolidated: false,
        });
        series = pickRicherBs(series, parseScreenerAnnualBsHtml(standHtml));
      } catch {
        /* keep first */
      }
    }
    if (bsUsable(series)) writeBsCache(key, series);
    return series;
  } catch {
    const cached = readBsCache(key, { allowExpired: true });
    if (cached && cached !== "blocked" && bsUsable(cached)) return cached;
    return emptyBs();
  }
}

/**
 * Shortlist fill: one Screener page → both the annual P&L and the balance
 * sheet caches (consolidated first; standalone only when it has fewer years).
 * Throws on a Screener block/pause so a batch can stop.
 */
export async function fetchScreenerPlAndBs(
  ticker: string,
): Promise<{ pl: boolean; bs: boolean }> {
  const key = ticker.trim().toUpperCase();
  if (!key) return { pl: false, bs: false };
  const html = await fetchScreenerCompanyHtml(key, { consolidated: true });
  let pl = parseScreenerAnnualPlHtml(html);
  let bs: ScreenerAnnualBs = parseScreenerAnnualBsHtml(html);
  if (!plUsable(pl) || plYearCount(pl) < 5 || seriesStale(pl.dates)) {
    try {
      const stand = await fetchScreenerCompanyHtml(key, { consolidated: false });
      pl = pickRicherScreenerAnnualPl(pl, parseScreenerAnnualPlHtml(stand));
      bs = pickRicherBs(bs, parseScreenerAnnualBsHtml(stand));
    } catch (e) {
      if (/blocked|paused|429|403|captcha/i.test(String(e))) throw e;
    }
  }
  const okPl = plUsable(pl);
  const okBs = bsUsable(bs);
  if (okPl) writePlCache(key, pl);
  if (okBs) writeBsCache(key, bs);
  return { pl: okPl, bs: okBs };
}

/** Write annual / P&L / BS / cash-flow caches from one company-page HTML (no HTTP). */
/**
 * Drop one ticker's saved Screener statements (annual, P&L, balance sheet,
 * cash flow, shareholding, ratios, peers, quarters and the quarter summary). Only after a fresh page is in hand:
 * used when the saved data belonged to a different company.
 */
export function clearScreenerStatementCaches(ticker: string): void {
  const key = ticker.trim().toUpperCase();
  if (!key) return;
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    for (const table of [
      "screener_annual_cache",
      "screener_annual_pl_cache",
      "screener_annual_bs_cache",
      "screener_annual_cf_cache",
      "screener_shareholding_cache",
      "screener_ratios_cache",
      "screener_peers_cache",
      "screener_quarters_cache",
      "quarter_metrics",
    ]) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE UPPER(ticker) = ?`).run(key);
      } catch {
        /* table not created yet */
      }
    }
  } finally {
    db.close();
  }
}

export function ingestCompanyPageHtml(
  ticker: string,
  html: string,
): { annual: boolean; pl: boolean; bs: boolean; cf: boolean } {
  const key = ticker.trim().toUpperCase();
  if (!key || !html) return { annual: false, pl: false, bs: false, cf: false };
  const series = parseScreenerAnnualHtml(html);
  const pl = parseScreenerAnnualPlHtml(html);
  const bs = parseScreenerAnnualBsHtml(html);
  const cf = parseScreenerAnnualCfHtml(html);
  const okA = series.sales.some((s) => s != null && s > 0);
  if (okA) writeCache(key, series);
  const okPl = plUsable(pl);
  if (okPl) writePlCache(key, pl);
  const okBs = bsUsable(bs);
  if (okBs) writeBsCache(key, bs);
  const okCf = cfUsable(cf);
  if (okCf) writeCfCache(key, cf);
  return { annual: okA, pl: okPl, bs: okBs, cf: okCf };
}

/** Merge a second page (usually standalone) into richer annual / P&L / BS / CF caches. */
export function ingestRicherCompanyPageHtml(
  ticker: string,
  html: string,
): { annual: boolean; pl: boolean; bs: boolean; cf: boolean } {
  const key = ticker.trim().toUpperCase();
  if (!key || !html) return { annual: false, pl: false, bs: false, cf: false };
  const prevA = readCache(key, { allowExpired: true });
  const prevPl = readPlCache(key, { allowExpired: true });
  const prevBs = readBsCache(key, { allowExpired: true });
  const prevCf = readCfCache(key, { allowExpired: true });
  const series = pickRicherScreenerAnnual(
    prevA && prevA !== "blocked" ? prevA : { dates: [], sales: [], eps: [], roce: [] },
    parseScreenerAnnualHtml(html),
  );
  const emptyPl: ScreenerAnnualPl = {
    dates: [],
    revenue: [],
    expenses: [],
    operating_profit: [],
    other_income: [],
    interest: [],
    depreciation: [],
    pbt: [],
    tax: [],
    pat: [],
    shares_cr: [],
    eps: [],
  };
  const pl = pickRicherScreenerAnnualPl(
    prevPl && prevPl !== "blocked" ? prevPl : emptyPl,
    parseScreenerAnnualPlHtml(html),
  );
  const bs = pickRicherBs(
    prevBs && prevBs !== "blocked" ? prevBs : emptyBs(),
    parseScreenerAnnualBsHtml(html),
  );
  const cf = pickRicherCf(
    prevCf && prevCf !== "blocked" ? prevCf : emptyCf(),
    parseScreenerAnnualCfHtml(html),
  );
  const okA = series.sales.some((s) => s != null && s > 0);
  if (okA) writeCache(key, series);
  const okPl = plUsable(pl);
  if (okPl) writePlCache(key, pl);
  const okBs = bsUsable(bs);
  if (okBs) writeBsCache(key, bs);
  const okCf = cfUsable(cf);
  if (okCf) writeCfCache(key, cf);
  return { annual: okA, pl: okPl, bs: okBs, cf: okCf };
}

/** Annual / P&L / BS caches still inside their normal TTL and not stale-by-FY. */
export function annualCachesFresh(ticker: string): {
  annual: boolean;
  pl: boolean;
  bs: boolean;
} {
  const key = ticker.trim().toUpperCase();
  const a = readCache(key);
  const p = readPlCache(key);
  const b = readBsCache(key);
  const annualOk =
    fetchedWithin("screener_annual_cache", key, CACHE_MS) &&
    !!a &&
    a !== "blocked" &&
    !seriesStale(a.dates);
  const plOk =
    fetchedWithin("screener_annual_pl_cache", key, PL_CACHE_MS) &&
    !!p &&
    p !== "blocked" &&
    !seriesStale(p.dates);
  const bsOk =
    fetchedWithin("screener_annual_bs_cache", key, CACHE_MS) &&
    !!b &&
    b !== "blocked" &&
    !seriesStale(b.dates);
  return { annual: annualOk, pl: plOk, bs: bsOk };
}

/**
 * One Screener page → annual series (sales / EPS / ROCE), P&L and balance
 * sheet, all cached. Falls back to standalone when consolidated is short or
 * stale-by-date (unless `standaloneIfShort: false` for bulk fills).
 */
export async function fetchScreenerAllAnnual(
  ticker: string,
  opts?: { standaloneIfShort?: boolean },
): Promise<{ annual: boolean; pl: boolean; bs: boolean }> {
  const key = ticker.trim().toUpperCase();
  if (!key) return { annual: false, pl: false, bs: false };
  const html = await fetchScreenerCompanyHtml(key, { consolidated: true });
  let got = ingestCompanyPageHtml(key, html);
  let series = readCache(key, { allowExpired: true });
  const salesN =
    series && series !== "blocked"
      ? series.sales.filter((s) => s != null && s > 0).length
      : 0;
  const stale = series && series !== "blocked" ? seriesStale(series.dates) : false;
  if (opts?.standaloneIfShort !== false && (salesN < 4 || stale)) {
    try {
      const stand = await fetchScreenerCompanyHtml(key, { consolidated: false });
      got = ingestRicherCompanyPageHtml(key, stand);
    } catch (e) {
      if (/blocked|paused|429|403|captcha/i.test(String(e))) throw e;
    }
  }
  markPageTried(key, got.annual, got.bs);
  return got;
}

/** Remember every company-page pull (even empty ones) so bulk fills do not
 *  ask Screener again for a page that had nothing. */
function markPageTried(ticker: string, gotAnnual: boolean, gotBs: boolean): void {
  try {
    ensureCacheSchema();
    const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
    try {
      db.prepare(
        `INSERT INTO screener_page_tried (ticker, tried_at, got_annual, got_bs) VALUES (?, ?, ?, ?)
         ON CONFLICT(ticker) DO UPDATE SET tried_at = excluded.tried_at, got_annual = excluded.got_annual, got_bs = excluded.got_bs`,
      ).run(ticker.toUpperCase(), new Date().toISOString(), gotAnnual ? 1 : 0, gotBs ? 1 : 0);
    } finally {
      db.close();
    }
  } catch {
    /* best effort */
  }
}

/** Tickers whose Screener page was pulled (or annual + balance sheet cached) since `sinceMs` ago. */
export function screenerPagesTriedSince(sinceMs: number): Set<string> {
  const out = new Set<string>();
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  try {
    ensureCacheSchema();
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t FROM screener_page_tried WHERE tried_at >= ?`).all(cutoff) as Array<{ t: string }>)
        out.add(r.t);
      // Annual + balance sheet both cached recently: the page has nothing new to give.
      try {
        for (const r of db
          .prepare(
            `SELECT UPPER(a.ticker) AS t FROM screener_annual_cache a
             JOIN screener_annual_bs_cache b ON UPPER(b.ticker) = UPPER(a.ticker)
             WHERE a.fetched_at >= ?`,
          )
          .all(cutoff) as Array<{ t: string }>)
          out.add(r.t);
      } catch {
        /* bs table not created yet */
      }
    } finally {
      db.close();
    }
  } catch {
    /* no db */
  }
  return out;
}

/** Cash-flow WC lines (Screener cash-flow section) for earnings-quality / fraud checks. */
export type ScreenerAnnualCf = {
  dates: string[];
  cfo: Array<number | null>;
  receivables: Array<number | null>;
  payables: Array<number | null>;
  inventory: Array<number | null>;
  /** Income tax paid (cash outflow; Screener often stores as negative). */
  tax_paid: Array<number | null>;
};

function emptyCf(): ScreenerAnnualCf {
  return { dates: [], cfo: [], receivables: [], payables: [], inventory: [], tax_paid: [] };
}

function ensureCfCacheSchema(): void {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS screener_annual_cf_cache (
        ticker TEXT PRIMARY KEY,
        cf_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        blocked_until TEXT
      );
    `);
  } finally {
    db.close();
  }
}

function readCfCache(
  ticker: string,
  opts?: { allowExpired?: boolean },
): ScreenerAnnualCf | "blocked" | null {
  ensureCfCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const row = db
      .prepare(
        `SELECT cf_json, fetched_at, blocked_until FROM screener_annual_cf_cache WHERE ticker = ?`,
      )
      .get(ticker.toUpperCase()) as
      | { cf_json: string; fetched_at: string; blocked_until: string | null }
      | undefined;
    if (!row) return null;
    if (row.blocked_until && Date.parse(row.blocked_until) > Date.now()) return "blocked";
    if (opts?.allowExpired || Date.now() - Date.parse(row.fetched_at) < CACHE_MS) {
      return normalizeCf(JSON.parse(row.cf_json) as ScreenerAnnualCf);
    }
    return null;
  } finally {
    db.close();
  }
}

function writeCfCache(ticker: string, series: ScreenerAnnualCf, blockedUntil: string | null = null): void {
  ensureCfCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO screener_annual_cf_cache (ticker, cf_json, fetched_at, blocked_until)
       VALUES (@ticker, @cf_json, @fetched_at, @blocked_until)
       ON CONFLICT(ticker) DO UPDATE SET
         cf_json = excluded.cf_json,
         fetched_at = excluded.fetched_at,
         blocked_until = excluded.blocked_until`,
    ).run({
      ticker: ticker.toUpperCase(),
      cf_json: JSON.stringify(series),
      fetched_at: new Date().toISOString(),
      blocked_until: blockedUntil,
    });
  } finally {
    db.close();
  }
}

export function parseScreenerAnnualCfHtml(html: string): ScreenerAnnualCf {
  const empty = emptyCf();
  if (/captcha|access denied|rate limit/i.test(html)) return empty;
  const $ = cheerio.load(html);
  const cf = parseScreenerSectionTable($, "cash-flow");
  if (!cf?.dates.length) return empty;
  const n = cf.dates.length;
  return {
    dates: cf.dates.slice(0, n),
    cfo: alignRow(
      n,
      pickScreenerRow(cf.rows, [
        /^Cash from Operating Activity\b/i,
        /^Cash from Operating Activities\b/i,
        /^Cash Flow from Operating/i,
      ]),
    ),
    receivables: alignRow(n, pickScreenerRow(cf.rows, [/^Receivables\b/i, /^Trade Receivables\b/i])),
    payables: alignRow(n, pickScreenerRow(cf.rows, [/^Payables\b/i, /^Trade Payables\b/i])),
    inventory: alignRow(n, pickScreenerRow(cf.rows, [/^Inventory\b/i, /^Inventories\b/i])),
    tax_paid: alignRow(
      n,
      pickScreenerRow(cf.rows, [
        /^Income Tax Paid\b/i,
        /^Taxes Paid\b/i,
        /^Tax Paid\b/i,
        /^Direct Taxes Paid\b/i,
      ]),
    ),
  };
}

function normalizeCf(cf: ScreenerAnnualCf): ScreenerAnnualCf {
  const n = cf.dates.length;
  return {
    dates: cf.dates,
    cfo: cf.cfo ?? Array(n).fill(null),
    receivables: cf.receivables ?? Array(n).fill(null),
    payables: cf.payables ?? Array(n).fill(null),
    inventory: cf.inventory ?? Array(n).fill(null),
    tax_paid: cf.tax_paid ?? Array(n).fill(null),
  };
}

function cfUsable(cf: ScreenerAnnualCf): boolean {
  const c = normalizeCf(cf);
  return (
    c.cfo.some((v) => v != null) ||
    c.receivables.some((v) => v != null) ||
    c.payables.some((v) => v != null) ||
    c.tax_paid.some((v) => v != null)
  );
}

function cfYearCount(cf: ScreenerAnnualCf): number {
  const c = normalizeCf(cf);
  return c.dates.filter(
    (_, i) =>
      c.cfo[i] != null ||
      c.receivables[i] != null ||
      c.payables[i] != null ||
      c.tax_paid[i] != null,
  ).length;
}

function pickRicherCf(a: ScreenerAnnualCf, b: ScreenerAnnualCf): ScreenerAnnualCf {
  const ua = cfUsable(a);
  const ub = cfUsable(b);
  if (ua && !ub) return a;
  if (ub && !ua) return b;
  if (!ua && !ub) return a;
  return newerByYear(a, b) ?? (cfYearCount(b) > cfYearCount(a) ? b : a);
}

export async function fetchScreenerAnnualCf(
  ticker: string,
  opts?: { force?: boolean; consolidated?: boolean },
): Promise<ScreenerAnnualCf> {
  const key = ticker.trim().toUpperCase();
  if (!key) return emptyCf();
  if (!opts?.force) {
    const cached = readCfCache(key);
    if (cached === "blocked") return emptyCf();
    if (
      cached &&
      cfUsable(cached) &&
      !seriesStale(cached.dates) &&
      (cfYearCount(cached) >= 3 || fetchedWithin("screener_annual_cf_cache", key, SHORT_OK_MS))
    ) {
      return cached;
    }
  }
  try {
    const html = await fetchScreenerCompanyHtml(key, {
      consolidated: opts?.consolidated !== false,
    });
    let series = parseScreenerAnnualCfHtml(html);
    // Also refresh PL/BS/annual from the same page so one pull feeds fraud checks.
    ingestCompanyPageHtml(key, html);
    if (opts?.consolidated !== false) {
      try {
        const standHtml = await fetchScreenerCompanyHtml(key, { consolidated: false });
        series = pickRicherCf(series, parseScreenerAnnualCfHtml(standHtml));
        ingestRicherCompanyPageHtml(key, standHtml);
      } catch {
        /* keep first */
      }
    }
    if (cfUsable(series)) writeCfCache(key, series);
    return series;
  } catch {
    const cached = readCfCache(key, { allowExpired: true });
    if (cached && cached !== "blocked" && cfUsable(cached)) return cached;
    return emptyCf();
  }
}
