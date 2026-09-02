/**
 * Screener.in quarterly results — consolidated table, throttled + cached.
 * Never bulk-search; one company page per request, 7d cache, 6h block backoff.
 */
import * as cheerio from "cheerio";
import { openSqliteNamed } from "./sqlite-utils";
import { fetchScreenerCompanyHtml } from "./screener-fetch";
import type { QuarterPoint } from "./quarter-panel";
import { trimReportedQuarters } from "./quarter-panel";

const CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const BLOCK_MS = 6 * 60 * 60 * 1000;

const MONTH_NUM: Record<string, string> = {
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

const MONTH_END: Record<string, number> = {
  JAN: 31,
  FEB: 28,
  MAR: 31,
  APR: 30,
  MAY: 31,
  JUN: 30,
  JUL: 31,
  AUG: 31,
  SEP: 30,
  OCT: 31,
  NOV: 30,
  DEC: 31,
};

function ensureCacheSchema(): void {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS screener_quarters_cache (
        ticker TEXT PRIMARY KEY,
        quarters_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        blocked_until TEXT
      );
    `);
  } finally {
    db.close();
  }
}

type CacheRow = {
  quarters_json: string;
  fetched_at: string;
  blocked_until: string | null;
};

function readCache(ticker: string): QuarterPoint[] | "blocked" | null {
  ensureCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const row = db
      .prepare(
        `SELECT quarters_json, fetched_at, blocked_until FROM screener_quarters_cache WHERE ticker = ?`,
      )
      .get(ticker.toUpperCase()) as CacheRow | undefined;
    if (!row) return null;
    if (row.blocked_until && Date.parse(row.blocked_until) > Date.now()) {
      return "blocked";
    }
    if (Date.now() - Date.parse(row.fetched_at) < CACHE_MS) {
      return JSON.parse(row.quarters_json) as QuarterPoint[];
    }
    return null;
  } finally {
    db.close();
  }
}

function writeCache(
  ticker: string,
  quarters: QuarterPoint[],
  blockedUntil?: string | null,
): void {
  ensureCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO screener_quarters_cache (ticker, quarters_json, fetched_at, blocked_until)
       VALUES (@ticker, @quarters_json, @fetched_at, @blocked_until)
       ON CONFLICT(ticker) DO UPDATE SET
         quarters_json = excluded.quarters_json,
         fetched_at = excluded.fetched_at,
         blocked_until = excluded.blocked_until`,
    ).run({
      ticker: ticker.toUpperCase(),
      quarters_json: JSON.stringify(quarters),
      fetched_at: new Date().toISOString(),
      blocked_until: blockedUntil ?? null,
    });
  } finally {
    db.close();
  }
}

function parsePeriodLabel(label: string): string | null {
  const m = label.trim().match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return null;
  const mon = m[1]!.toUpperCase();
  const month = MONTH_NUM[mon];
  const day = MONTH_END[mon];
  if (!month || !day) return null;
  return `${m[2]}-${month}-${String(day).padStart(2, "0")}`;
}

function parseNum(raw: string): number | null {
  const t = raw.replace(/\u00a0/g, " ").replace(/,/g, "").replace(/%$/, "").trim();
  if (!t || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function pickResultsTable($: cheerio.CheerioAPI): cheerio.Cheerio | null {
  let picked: cheerio.Cheerio | null = null;

  $("h2").each((_, h2) => {
    const title = $(h2).text().trim();
    if (!/^(Quarterly|Half Yearly) Results$/i.test(title)) return;
    const table = $(h2).closest("section").find("table").first();
    if (table.length) {
      picked = table;
      return false;
    }
  });

  if (picked?.length) return picked;

  $("table").each((_, el) => {
    const headers = $(el)
      .find("thead th")
      .map((__, th) => $(th).text().trim())
      .get()
      .filter(Boolean);
    const periodCols = headers.filter((h) => parsePeriodLabel(h));
    if (periodCols.length >= 2) {
      picked = $(el);
      return false;
    }
  });

  return picked?.length ? picked : null;
}

/** Parse Screener quarterly table (values already in ₹ Cr). */
export function parseScreenerQuarterlyHtml(html: string): QuarterPoint[] {
  if (/captcha|access denied|rate limit/i.test(html)) return [];

  const $ = cheerio.load(html);
  const table = pickResultsTable($);
  if (!table) return [];

  const headers = table
    .find("thead th")
    .map((_, th) => $(th).text().trim())
    .get();

  const periods: Array<{ idx: number; date: string }> = [];
  headers.forEach((h, idx) => {
    if (idx === 0) return;
    const date = parsePeriodLabel(h);
    if (date) periods.push({ idx, date });
  });
  if (periods.length < 2) return [];

  const byDate = new Map<string, QuarterPoint>();
  for (const p of periods) {
    byDate.set(p.date, {
      date: p.date,
      revenue: null,
      netIncome: null,
      eps: null,
      ebit: null,
      otherIncome: null,
    });
  }

  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr)
      .find("td, th")
      .map((__, td) => $(td).text().trim())
      .get();
    if (cells.length < 2) return;

    const label =
      cells[0]?.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase() ||
      "";
    let field: keyof Pick<
      QuarterPoint,
      "revenue" | "netIncome" | "eps" | "ebit" | "otherIncome"
    > | null = null;
    if (label.startsWith("sales")) field = "revenue";
    else if (label.startsWith("net profit")) field = "netIncome";
    else if (label.startsWith("eps")) field = "eps";
    else if (label.startsWith("operating profit")) field = "ebit";
    else if (label.startsWith("other income")) field = "otherIncome";
    if (!field) return;

    for (const p of periods) {
      const val = parseNum(cells[p.idx] || "");
      if (val == null) continue;
      const point = byDate.get(p.date);
      if (point) point[field] = val;
    }
  });

  return trimReportedQuarters(
    [...byDate.values()].filter(
      (q) => q.revenue != null || q.netIncome != null || q.eps != null,
    ),
  );
}

/** Overlay Screener consolidated P&L onto Yahoo quarters (same dates). */
export function mergeScreenerQuarterOverlay(
  base: QuarterPoint[],
  screener: QuarterPoint[],
): QuarterPoint[] {
  if (!screener.length) return base;
  const byDate = new Map(screener.map((q) => [q.date.slice(0, 10), q]));
  return base.map((q) => {
    const sc = byDate.get(q.date.slice(0, 10));
    if (!sc) return q;
    return {
      ...q,
      ebit: sc.ebit ?? q.ebit,
      otherIncome: sc.otherIncome ?? q.otherIncome,
      revenue: sc.revenue ?? q.revenue,
      netIncome: sc.netIncome ?? q.netIncome,
      eps: sc.eps ?? q.eps,
    };
  });
}

export type ScreenerQuarterOpts = {
  force?: boolean;
  /** Skip network — return cache only (for throttling). */
  cacheOnly?: boolean;
  consolidated?: boolean;
};

/**
 * Fetch consolidated quarterly table from Screener company page.
 * Cached 7d; backs off 6h on block. Never uses global search.
 */
export async function fetchScreenerQuarterlyFundamentals(
  ticker: string,
  opts?: ScreenerQuarterOpts,
): Promise<QuarterPoint[]> {
  const key = ticker.trim().toUpperCase();
  if (!key) return [];

  if (!opts?.force) {
    const cached = readCache(key);
    if (cached === "blocked") return [];
    if (cached) return cached;
    if (opts?.cacheOnly) return [];
  }

  try {
    const html = await fetchScreenerCompanyHtml(key, {
      consolidated: opts?.consolidated !== false,
    });
    const quarters = parseScreenerQuarterlyHtml(html);
    writeCache(key, quarters);
    return quarters;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/blocked|429|403|captcha/i.test(msg)) {
      const until = new Date(Date.now() + BLOCK_MS).toISOString();
      writeCache(key, [], until);
    }
    return [];
  }
}
