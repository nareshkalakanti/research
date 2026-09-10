/**
 * Screener.in annual P&L + ratios (Sales, EPS, ROCE %) for Brutal scanner.
 */
import * as cheerio from "cheerio";
import { fetchScreenerCompanyHtml } from "./screener-fetch";
import { openSqliteNamed } from "./sqlite-utils";

const CACHE_MS = 14 * 24 * 60 * 60 * 1000;
const BLOCK_MS = 6 * 60 * 60 * 1000;

export type ScreenerAnnualSeries = {
  dates: string[];
  sales: Array<number | null>;
  eps: Array<number | null>;
  roce: Array<number | null>;
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
    `);
  } finally {
    db.close();
  }
}

function readCache(ticker: string): ScreenerAnnualSeries | "blocked" | null {
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
    if (Date.now() - Date.parse(row.fetched_at) < CACHE_MS) {
      return JSON.parse(row.annual_json) as ScreenerAnnualSeries;
    }
    return null;
  } finally {
    db.close();
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

function parseSectionTable(
  $: CheerioLoaded,
  sectionId: string,
): { dates: string[]; rows: Map<string, Array<number | null>> } | null {
  const section = $(`#${sectionId}`);
  if (!section.length) return null;
  const table = section.find("table.data-table").first();
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
  if (dates.length < 2) return null;

  const rows = new Map<string, Array<number | null>>();
  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td, th");
    if (cells.length < 2) return;
    const name = $(cells[0]).text().replace(/\s+/g, " ").trim();
    if (!name) return;
    const vals: Array<number | null> = [];
    for (const idx of dateIdx) {
      vals.push(parseNum($(cells[idx]).text()));
    }
    rows.set(name, vals);
  });

  return { dates, rows };
}

function pickRow(
  rows: Map<string, Array<number | null>>,
  patterns: RegExp[],
): Array<number | null> | null {
  for (const [name, vals] of rows) {
    for (const re of patterns) {
      if (re.test(name)) return vals;
    }
  }
  return null;
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
  const pl = parseSectionTable($, "profit-loss");
  const ratios = parseSectionTable($, "ratios");
  if (!pl && !ratios) return empty;

  const dates = pl?.dates ?? ratios?.dates ?? [];
  const sales = pl
    ? pickRow(pl.rows, [/^Sales\b/i, /^Revenue\b/i])
    : null;
  const eps = pl
    ? pickRow(pl.rows, [/^EPS\b/i, /EPS in Rs/i])
    : null;
  const roce = ratios
    ? pickRow(ratios.rows, [/^ROCE\b/i])
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
    // Ignore empty / sales-less cache so we can retry parse / standalone
    if (cached && cached.sales.some((s) => s != null && s > 0)) {
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
    // Some SME / young listings only populate standalone
    if (
      !series.sales.some((s) => s != null && s > 0) &&
      opts?.consolidated !== false
    ) {
      try {
        const standHtml = await fetchScreenerCompanyHtml(key, {
          consolidated: false,
        });
        const stand = parseScreenerAnnualHtml(standHtml);
        if (stand.sales.some((s) => s != null && s > 0)) series = stand;
      } catch {
        /* keep consolidated parse */
      }
    }
    // Only cache useful series — empty miss should not poison for 14 days
    if (series.sales.some((s) => s != null && s > 0)) {
      writeCache(key, series);
    }
    return series;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/blocked|429|403|captcha/i.test(msg)) {
      const until = new Date(Date.now() + BLOCK_MS).toISOString();
      writeCache(
        key,
        { dates: [], sales: [], eps: [], roce: [] },
        until,
      );
    }
    return { dates: [], sales: [], eps: [], roce: [] };
  }
}
