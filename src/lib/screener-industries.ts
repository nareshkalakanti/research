/**
 * Screener.in market tree → ticker sector / industry / sub_sector.
 * Leaf pages under /market/IN…/; breadcrumbs collapse duplicate crumbs.
 */
import { bseCodeOwner } from "./bse-codes";
import type { FillResult, Progress } from "./nanocap-champs";
import {
  fetchScreenerHtml,
  ScreenerPausedError,
  screenerPausedUntil,
} from "./screener-fetch";
import { openSqliteNamed } from "./sqlite-utils";

const MARKET_ROOT = "https://www.screener.in/market/";
const MARKET_PATH_RE = /\/market\/(?:IN[0-9]+\/)+/;

export type ScreenerIndustryLabels = {
  sector: string;
  industry: string;
  sub_sector: string;
};

export type ScreenerIndustryStatus = {
  mapped: number;
  /** Sum of leaf "results found" — final Screener industry stock count (incl. SME). */
  companies_total: number;
  /** Leaf industry pages discovered on the last/current crawl. */
  leaves: number;
  /** Leaf paths finished (saved for resume). */
  done_leaves: number;
  /** Crawl marked active and not every leaf is done yet. */
  active: boolean;
  last: string | null;
  paused_until: string | null;
};

let stopFlag = false;

export function stopScreenerIndustryCrawl(): void {
  stopFlag = true;
  setMeta("active", "0");
}

type Db = ReturnType<typeof openSqliteNamed>;

function withDb<T>(fn: (db: Db) => T): T {
  // Always writable so a missing file is created (status before first sync).
  const db = openSqliteNamed("screener_industries.db", { wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS screener_industry (
        ticker TEXT PRIMARY KEY,
        market_path TEXT NOT NULL,
        sector TEXT NOT NULL,
        industry TEXT NOT NULL,
        sub_sector TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_si_sector ON screener_industry(sector);
      CREATE INDEX IF NOT EXISTS idx_si_sub ON screener_industry(sub_sector);
      CREATE TABLE IF NOT EXISTS screener_industry_meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      -- One row per Screener /market/ leaf (crawl progress + labels).
      CREATE TABLE IF NOT EXISTS screener_leaf (
        market_path TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        sector TEXT,
        industry TEXT,
        sub_sector TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        ticker_count INTEGER NOT NULL DEFAULT 0,
        fetched_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sl_status ON screener_leaf(status);
    `);
    migrateDonePathsToLeaf(db);
    ensureLeafOverviewColumns(db);
    return fn(db);
  } finally {
    db.close();
  }
}

/** Screener /market/ overview ratios (one row per industry leaf). */
const LEAF_OVERVIEW_COLS: Array<{ name: string; sql: string }> = [
  { name: "list_order", sql: "INTEGER" },
  { name: "companies", sql: "INTEGER" },
  { name: "total_mcap", sql: "REAL" },
  { name: "median_mcap", sql: "REAL" },
  { name: "median_pe", sql: "REAL" },
  { name: "sales_growth", sql: "REAL" },
  { name: "opm", sql: "REAL" },
  { name: "wtd_avg_roce", sql: "REAL" },
  { name: "median_1y_return", sql: "REAL" },
  { name: "overview_at", sql: "TEXT" },
  /** Leaf page "N results found" — includes SME / BSE; overview companies often omit SME. */
  { name: "results_found", sql: "INTEGER" },
];

function ensureLeafOverviewColumns(db: Db): void {
  const have = new Set(
    (db.prepare(`PRAGMA table_info(screener_leaf)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  for (const col of LEAF_OVERVIEW_COLS) {
    if (have.has(col.name)) continue;
    db.exec(`ALTER TABLE screener_leaf ADD COLUMN ${col.name} ${col.sql}`);
  }
}

/** One-shot: move legacy done_paths JSON meta into screener_leaf rows. */
function migrateDonePathsToLeaf(db: Db): void {
  const raw = getMeta(db, "done_paths");
  if (!raw) return;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || !arr.length) {
      db.prepare(`DELETE FROM screener_industry_meta WHERE k = 'done_paths'`).run();
      return;
    }
    const ins = db.prepare(
      `INSERT INTO screener_leaf (market_path, title, status, fetched_at)
       VALUES (?, ?, 'done', ?)
       ON CONFLICT(market_path) DO UPDATE SET
         status = CASE WHEN screener_leaf.status = 'pending' THEN 'done' ELSE screener_leaf.status END,
         fetched_at = COALESCE(screener_leaf.fetched_at, excluded.fetched_at)`,
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const p of arr) {
        if (typeof p !== "string" || !p) continue;
        ins.run(p, p, now);
      }
      db.prepare(`DELETE FROM screener_industry_meta WHERE k = 'done_paths'`).run();
    })();
  } catch {
    /* leave meta; next open retries */
  }
}

function setMeta(k: string, v: string): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO screener_industry_meta (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(k, v);
  });
}

function getMeta(db: Db, k: string): string | null {
  const row = db.prepare(`SELECT v FROM screener_industry_meta WHERE k = ?`).get(k) as
    | { v: string }
    | undefined;
  return row?.v ?? null;
}

function leafCounts(db: Db): { leaves: number; done_leaves: number } {
  const leaves = (db.prepare(`SELECT COUNT(*) AS n FROM screener_leaf`).get() as { n: number }).n;
  const done_leaves = (
    db.prepare(`SELECT COUNT(*) AS n FROM screener_leaf WHERE status IN ('done', 'skip')`).get() as {
      n: number;
    }
  ).n;
  return { leaves, done_leaves };
}

export function screenerIndustryStatus(): ScreenerIndustryStatus {
  return withDb((db) => {
    const mapped = (
      db.prepare(`SELECT COUNT(*) AS n FROM screener_industry`).get() as { n: number }
    ).n;
    const companies_total = (
      db
        .prepare(
          `SELECT COALESCE(SUM(COALESCE(results_found, companies, ticker_count, 0)), 0) AS n
             FROM screener_leaf`,
        )
        .get() as { n: number }
    ).n;
    const { leaves, done_leaves } = leafCounts(db);
    const metaLeaves = Number(getMeta(db, "leaves") || "0") || 0;
    const total = Math.max(leaves, metaLeaves);
    const active = getMeta(db, "active") === "1" && (total === 0 || done_leaves < total);
    return {
      mapped,
      companies_total,
      leaves: total,
      done_leaves,
      active,
      last: getMeta(db, "last"),
      paused_until: screenerPausedUntil(),
    };
  });
}

/** Collapse consecutive duplicate crumbs; drop Industries root. */
export function labelsFromBreadcrumbs(crumbs: string[]): ScreenerIndustryLabels | null {
  const raw = crumbs.map((c) => c.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const c of raw) {
    if (/^industries$/i.test(c)) continue;
    if (parts.length && parts[parts.length - 1]!.toLowerCase() === c.toLowerCase()) continue;
    parts.push(c);
  }
  if (!parts.length) return null;
  if (parts.length === 1) {
    const only = parts[0]!;
    return { sector: only, industry: only, sub_sector: only };
  }
  if (parts.length === 2) {
    return { sector: parts[0]!, industry: parts[1]!, sub_sector: parts[1]! };
  }
  // sector = first; industry = penultimate (Transport Services, Capital Goods, Automobiles);
  // sub_sector = leaf (Airline, Aerospace & Defense, 2/3 Wheelers).
  return {
    sector: parts[0]!,
    industry: parts[parts.length - 2]!,
    sub_sector: parts[parts.length - 1]!,
  };
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeHtml(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

export type ScreenerMarketOverviewRow = {
  list_order: number;
  path: string;
  title: string;
  companies: number | null;
  total_mcap: number | null;
  median_mcap: number | null;
  median_pe: number | null;
  sales_growth: number | null;
  opm: number | null;
  wtd_avg_roce: number | null;
  median_1y_return: number | null;
};

function parseInNumber(raw: string): number | null {
  const t = stripTags(raw).replace(/,/g, "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parsePctCell(raw: string): number | null {
  const t = stripTags(raw).replace(/%/g, "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Full Industries Overview table from screener.in/market/
 * (S.No., Industry, companies, mcaps, PE, growth, OPM, ROCE, 1Y).
 */
export function parseMarketOverview(html: string): ScreenerMarketOverviewRow[] {
  const re =
    /<tr>\s*<td class="text ink-600">(\d+)\.<\/td>\s*<td class="text">\s*<a href="(\/market\/(?:IN[0-9]+\/)+)"[^>]*>([^<]+)<\/a>\s*<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  const out: ScreenerMarketOverviewRow[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(re)) {
    const path = m[2]!;
    if (seen.has(path)) continue;
    seen.add(path);
    const title = decodeHtml(m[3] || "").trim();
    if (!title || /^industries$/i.test(title)) continue;
    out.push({
      list_order: Number(m[1]) || out.length + 1,
      path,
      title,
      companies: parseInNumber(m[4] || ""),
      total_mcap: parseInNumber(m[5] || ""),
      median_mcap: parseInNumber(m[6] || ""),
      median_pe: parseInNumber(m[7] || ""),
      sales_growth: parsePctCell(m[8] || ""),
      opm: parsePctCell(m[9] || ""),
      wtd_avg_roce: parsePctCell(m[10] || ""),
      median_1y_return: parsePctCell(m[11] || ""),
    });
  }
  out.sort((a, b) => a.list_order - b.list_order || a.title.localeCompare(b.title));
  return out;
}

/** Leaf market paths + titles from the Industries overview. */
export function parseMarketLeaves(html: string): Array<{ path: string; title: string }> {
  const rows = parseMarketOverview(html);
  if (rows.length) return rows.map((r) => ({ path: r.path, title: r.title }));
  // Fallback: links only (older HTML / partial pages).
  const out = new Map<string, string>();
  for (const m of html.matchAll(/href="(\/market\/(?:IN[0-9]+\/)+)"/g)) {
    const path = m[1]!;
    const rest = html.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
    const gt = rest.indexOf(">");
    const end = rest.indexOf("</a>", gt);
    if (gt < 0 || end < 0) continue;
    const title = stripTags(rest.slice(gt + 1, end));
    if (!title || /^industries$/i.test(title)) continue;
    out.set(path, title);
  }
  return [...out.entries()]
    .map(([path, title]) => ({ path, title }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Persist overview ratios onto screener_leaf (same columns as screener.in/market/). */
export function syncMarketOverview(rows: ScreenerMarketOverviewRow[]): number {
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  return withDb((db) => {
    const upsert = db.prepare(
      `INSERT INTO screener_leaf (
         market_path, title, status, list_order, companies,
         total_mcap, median_mcap, median_pe, sales_growth, opm,
         wtd_avg_roce, median_1y_return, overview_at
       ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(market_path) DO UPDATE SET
         title = excluded.title,
         list_order = excluded.list_order,
         companies = excluded.companies,
         total_mcap = excluded.total_mcap,
         median_mcap = excluded.median_mcap,
         median_pe = excluded.median_pe,
         sales_growth = excluded.sales_growth,
         opm = excluded.opm,
         wtd_avg_roce = excluded.wtd_avg_roce,
         median_1y_return = excluded.median_1y_return,
         overview_at = excluded.overview_at`,
    );
    db.transaction(() => {
      for (const r of rows) {
        upsert.run(
          r.path,
          r.title,
          r.list_order,
          r.companies,
          r.total_mcap,
          r.median_mcap,
          r.median_pe,
          r.sales_growth,
          r.opm,
          r.wtd_avg_roce,
          r.median_1y_return,
          now,
        );
      }
    })();
    db.prepare(
      `INSERT INTO screener_industry_meta (k, v) VALUES ('overview_at', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(now);
    db.prepare(
      `INSERT INTO screener_industry_meta (k, v) VALUES ('leaves', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(String(rows.length));
    return rows.length;
  });
}

/** Fetch screener.in/market/ and store the overview ratio table. */
export async function refreshScreenerMarketOverview(): Promise<number> {
  if (screenerPausedUntil()) {
    throw new ScreenerPausedError(screenerPausedUntil()!);
  }
  const html = await fetchHtml(MARKET_ROOT);
  const rows = parseMarketOverview(html);
  if (!rows.length) throw new Error("No Screener market overview rows found");
  return syncMarketOverview(rows);
}

/**
 * Page-1 only per leaf: store "N results found" (includes SME/BSE on the leaf).
 * Does not re-map tickers — run industry sync (force) for that after the parser fix.
 */
export async function refreshScreenerLeafResultCounts(
  onProgress?: Progress,
): Promise<{ updated: number; total: number }> {
  if (screenerPausedUntil()) {
    throw new ScreenerPausedError(screenerPausedUntil()!);
  }
  const paths = withDb((db) => {
    return (
      db.prepare(`SELECT market_path FROM screener_leaf ORDER BY list_order ASC, title COLLATE NOCASE`).all() as Array<{
        market_path: string;
      }>
    ).map((r) => r.market_path);
  });
  let updated = 0;
  const upd = (path: string, n: number | null) => {
    withDb((db) => {
      db.prepare(`UPDATE screener_leaf SET results_found = ? WHERE market_path = ?`).run(n, path);
    });
  };
  for (let i = 0; i < paths.length; i += 1) {
    if (stopFlag) break;
    if (screenerPausedUntil()) throw new ScreenerPausedError(screenerPausedUntil()!);
    const path = paths[i]!;
    try {
      const html = await fetchHtml(`https://www.screener.in${path}`);
      const n = parseResultsFound(html);
      upd(path, n);
      if (n != null) updated += 1;
    } catch {
      /* keep prior results_found */
    }
    onProgress?.(i + 1, paths.length, updated);
  }
  return { updated, total: paths.length };
}

/** True when overview ratios are missing or older than maxAgeMs (default 12h). */
export function screenerMarketOverviewStale(maxAgeMs = 12 * 60 * 60 * 1000): boolean {
  return withDb((db) => {
    const at = getMeta(db, "overview_at");
    if (!at) return true;
    const ts = Date.parse(at);
    if (!Number.isFinite(ts) || Date.now() - ts > maxAgeMs) return true;
    const withRatios = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM screener_leaf WHERE total_mcap IS NOT NULL`)
        .get() as { n: number }
    ).n;
    return withRatios === 0;
  });
}

export function parseBreadcrumbs(html: string): string[] {
  const block = html.match(/<div class="breadcrumb[\s\S]*?<\/div>/i)?.[0];
  if (!block) return [];
  const crumbs: string[] = [];
  for (const li of block.matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
    const text = stripTags(li[1] || "");
    if (text) crumbs.push(text);
  }
  return crumbs;
}

/**
 * Company keys from a market table (NSE symbols or BSE scrip codes).
 * Screener links are often `/company/TICKER/consolidated/` — not only `/company/TICKER/`.
 */
export function parseCompanyKeys(html: string): string[] {
  const keys = new Set<string>();
  const skip = new Set(["CONSOLIDATED", "STANDALONE"]);
  for (const m of html.matchAll(
    /href="\/company\/([^"/]+)(?:\/(?:consolidated|standalone))?\/"/gi,
  )) {
    const raw = decodeURIComponent(m[1] || "").trim().toUpperCase();
    if (!raw || skip.has(raw)) continue;
    keys.add(raw);
  }
  return [...keys];
}

/** "218 results found: Showing page 1 of 9" — full leaf size incl. SME when Screener lists them. */
export function parseResultsFound(html: string): number | null {
  const m = html.match(/(\d+)\s+results?\s+found/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function pageCount(html: string): number {
  const m = html.match(/Showing page\s+\d+\s+of\s+(\d+)/i);
  if (m) return Math.max(1, Number(m[1]) || 1);
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((x) => Number(x[1]));
  return pages.length ? Math.max(1, ...pages) : 1;
}

/** Resolve Screener company URL key → our ticker when possible. */
export function resolveScreenerCompanyKey(key: string): string | null {
  const k = key.trim().toUpperCase();
  if (!k) return null;
  if (/^\d{5,7}$/.test(k)) return bseCodeOwner(k);
  return k;
}

function upsertRow(
  ticker: string,
  marketPath: string,
  labels: ScreenerIndustryLabels,
): void {
  const t = ticker.trim().toUpperCase();
  if (!t) return;
  const now = new Date().toISOString();
  withDb((db) => {
    db.prepare(
      `INSERT INTO screener_industry (ticker, market_path, sector, industry, sub_sector, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET
         market_path = excluded.market_path,
         sector = excluded.sector,
         industry = excluded.industry,
         sub_sector = excluded.sub_sector,
         updated_at = excluded.updated_at`,
    ).run(t, marketPath, labels.sector, labels.industry, labels.sub_sector, now);
  });
}

export function loadScreenerIndustryMap(): Map<
  string,
  ScreenerIndustryLabels & { market_path: string }
> {
  const out = new Map<string, ScreenerIndustryLabels & { market_path: string }>();
  try {
    withDb((db) => {
      const rows = db
        .prepare(
          `SELECT UPPER(ticker) AS t, market_path, sector, industry, sub_sector
             FROM screener_industry`,
        )
        .all() as Array<{
        t: string;
        market_path: string;
        sector: string;
        industry: string;
        sub_sector: string;
      }>;
      for (const r of rows) {
        if (!r.t) continue;
        out.set(r.t, {
          market_path: r.market_path,
          sector: r.sector,
          industry: r.industry,
          sub_sector: r.sub_sector,
        });
      }
    });
  } catch {
    /* db missing on fresh machines */
  }
  return out;
}

export type ScreenerLeafRow = {
  market_path: string;
  title: string;
  sector: string | null;
  industry: string | null;
  sub_sector: string | null;
  status: string;
  /** Crawl-mapped ticker count (may lag Screener's published companies). */
  ticker_count: number;
  /** Screener overview "No. of Companies" (often excludes SME). */
  companies: number | null;
  /** Leaf "N results found" — prefer for counts; includes SME/BSE when listed. */
  results_found: number | null;
  list_order: number | null;
  total_mcap: number | null;
  median_mcap: number | null;
  median_pe: number | null;
  sales_growth: number | null;
  opm: number | null;
  wtd_avg_roce: number | null;
  median_1y_return: number | null;
  overview_at: string | null;
  fetched_at: string | null;
};

export type ScreenerTickerRow = {
  ticker: string;
  sector: string;
  industry: string;
  sub_sector: string;
  market_path: string;
  updated_at: string;
};

/**
 * Browse leaf pages — same order/columns as screener.in/market/.
 * `companies` shown to UI prefers leaf results_found (incl. SME) over overview.
 */
export function listScreenerLeaves(q = ""): ScreenerLeafRow[] {
  const needle = q.trim().toLowerCase();
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT l.market_path, l.title, l.sector, l.industry, l.sub_sector, l.status,
                COALESCE(
                  (SELECT COUNT(*) FROM screener_industry i WHERE i.market_path = l.market_path),
                  l.ticker_count
                ) AS ticker_count,
                COALESCE(l.results_found, l.companies) AS companies,
                l.results_found, l.list_order,
                l.total_mcap, l.median_mcap, l.median_pe,
                l.sales_growth, l.opm, l.wtd_avg_roce, l.median_1y_return,
                l.overview_at, l.fetched_at
           FROM screener_leaf l
          ORDER BY CASE WHEN l.list_order IS NULL THEN 1 ELSE 0 END,
                   l.list_order ASC,
                   COALESCE(l.sub_sector, l.title) COLLATE NOCASE,
                   l.title COLLATE NOCASE`,
      )
      .all() as ScreenerLeafRow[];
    if (!needle) return rows;
    return rows.filter((r) =>
      [r.title, r.sector, r.industry, r.sub_sector, r.market_path]
        .filter(Boolean)
        .some((x) => String(x).toLowerCase().includes(needle)),
    );
  });
}

/** Browse ticker → sector/industry/sub_sector rows (optional filters). */
export function listScreenerIndustryTickers(opts?: {
  q?: string;
  sector?: string;
  industry?: string;
  sub_sector?: string;
  market_path?: string;
  limit?: number;
}): { rows: ScreenerTickerRow[]; total: number } {
  const q = (opts?.q || "").trim().toLowerCase();
  const sector = (opts?.sector || "").trim();
  const industry = (opts?.industry || "").trim();
  const sub = (opts?.sub_sector || "").trim();
  const path = (opts?.market_path || "").trim();
  // Default high enough for the full mapped set (~5–6k); callers can pass lower.
  const limit = Math.min(20_000, Math.max(50, opts?.limit ?? 10_000));
  return withDb((db) => {
    const where: string[] = [];
    const args: string[] = [];
    if (sector) {
      where.push(`sector = ?`);
      args.push(sector);
    }
    if (industry) {
      where.push(`industry = ?`);
      args.push(industry);
    }
    if (sub) {
      where.push(`sub_sector = ?`);
      args.push(sub);
    }
    if (path) {
      where.push(`market_path = ?`);
      args.push(path);
    }
    if (q) {
      where.push(
        `(UPPER(ticker) LIKE ? OR sector LIKE ? OR industry LIKE ? OR sub_sector LIKE ?)`,
      );
      const like = `%${q}%`;
      args.push(like.toUpperCase(), like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM screener_industry ${clause}`).get(...args) as {
        n: number;
      }
    ).n;
    const rows = db
      .prepare(
        `SELECT UPPER(ticker) AS ticker, sector, industry, sub_sector, market_path, updated_at
           FROM screener_industry
           ${clause}
          ORDER BY sector COLLATE NOCASE, industry COLLATE NOCASE,
                   sub_sector COLLATE NOCASE, ticker
          LIMIT ?`,
      )
      .all(...args, limit) as ScreenerTickerRow[];
    return { rows, total };
  });
}

async function fetchHtml(url: string): Promise<string> {
  const r = await fetchScreenerHtml(url);
  if (!r.ok) throw new Error(`Screener market page failed (${r.status})`);
  return r.html;
}

function loadDonePaths(): Set<string> {
  return withDb((db) => {
    const rows = db
      .prepare(`SELECT market_path FROM screener_leaf WHERE status IN ('done', 'skip')`)
      .all() as Array<{ market_path: string }>;
    return new Set(rows.map((r) => r.market_path));
  });
}

/** Register every leaf from /market/; force resets unfinished rows to pending. */
function syncLeafRoster(
  leaves: Array<{ path: string; title: string }>,
  opts?: { force?: boolean },
): void {
  withDb((db) => {
    const upsert = db.prepare(
      `INSERT INTO screener_leaf (market_path, title, status)
       VALUES (?, ?, 'pending')
       ON CONFLICT(market_path) DO UPDATE SET title = excluded.title`,
    );
    const reset = db.prepare(
      `UPDATE screener_leaf SET status = 'pending', sector = NULL, industry = NULL,
         sub_sector = NULL, ticker_count = 0, fetched_at = NULL
       WHERE market_path = ?`,
    );
    db.transaction(() => {
      for (const leaf of leaves) {
        upsert.run(leaf.path, leaf.title);
        if (opts?.force) reset.run(leaf.path);
      }
    })();
  });
}

function markLeafDone(
  path: string,
  opts: {
    status: "done" | "skip";
    labels?: ScreenerIndustryLabels | null;
    tickerCount?: number;
    resultsFound?: number | null;
  },
): void {
  const now = new Date().toISOString();
  withDb((db) => {
    db.prepare(
      `INSERT INTO screener_leaf (
         market_path, title, sector, industry, sub_sector, status,
         ticker_count, results_found, fetched_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(market_path) DO UPDATE SET
         sector = COALESCE(excluded.sector, screener_leaf.sector),
         industry = COALESCE(excluded.industry, screener_leaf.industry),
         sub_sector = COALESCE(excluded.sub_sector, screener_leaf.sub_sector),
         status = excluded.status,
         ticker_count = excluded.ticker_count,
         results_found = COALESCE(excluded.results_found, screener_leaf.results_found),
         fetched_at = excluded.fetched_at`,
    ).run(
      path,
      path,
      opts.labels?.sector ?? null,
      opts.labels?.industry ?? null,
      opts.labels?.sub_sector ?? null,
      opts.status,
      opts.tickerCount ?? 0,
      opts.resultsFound ?? null,
      now,
    );
  });
}

/** True when a crawl was started and not every leaf is done yet. */
export function screenerIndustryCrawlPending(): boolean {
  return withDb((db) => {
    if (getMeta(db, "active") !== "1") return false;
    const { leaves, done_leaves } = leafCounts(db);
    const metaLeaves = Number(getMeta(db, "leaves") || "0") || 0;
    const total = Math.max(leaves, metaLeaves);
    if (total <= 0) return true;
    return done_leaves < total;
  });
}

/**
 * Crawl all leaf industries from Screener /market/ and write ticker labels.
 * Resumes skipped leaves; runs on the server — leaving the browser tab is fine
 * as long as `next dev` / the Node process stays up.
 */
export async function crawlScreenerIndustries(
  onProgress?: Progress,
  opts?: { force?: boolean },
): Promise<FillResult> {
  stopFlag = false;
  setMeta("active", "1");
  if (screenerPausedUntil()) {
    throw new ScreenerPausedError(screenerPausedUntil()!);
  }

  const overview = await fetchHtml(MARKET_ROOT);
  const overviewRows = parseMarketOverview(overview);
  const leaves = overviewRows.length
    ? overviewRows.map((r) => ({ path: r.path, title: r.title }))
    : parseMarketLeaves(overview);
  if (!leaves.length) throw new Error("No Screener market leaves found on /market/");
  if (overviewRows.length) syncMarketOverview(overviewRows);
  setMeta("leaves", String(leaves.length));
  syncLeafRoster(leaves, { force: opts?.force === true });

  const donePaths = opts?.force ? new Set<string>() : loadDonePaths();

  let done = donePaths.size;
  let filled = 0;
  onProgress?.(done, leaves.length, filled);

  for (const leaf of leaves) {
    if (stopFlag) break;
    if (screenerPausedUntil()) {
      throw new ScreenerPausedError(screenerPausedUntil()!);
    }

    const path = leaf.path;
    if (!MARKET_PATH_RE.test(path)) {
      markLeafDone(path, { status: "skip" });
      donePaths.add(path);
      done = donePaths.size;
      onProgress?.(done, leaves.length, filled);
      continue;
    }
    if (donePaths.has(path)) {
      onProgress?.(donePaths.size, leaves.length, filled);
      continue;
    }

    const firstUrl = `https://www.screener.in${path}`;
    let html = await fetchHtml(firstUrl);
    const crumbs = parseBreadcrumbs(html);
    const labels = labelsFromBreadcrumbs(crumbs);
    const resultsFound = parseResultsFound(html);
    if (!labels) {
      markLeafDone(path, { status: "skip", resultsFound });
      donePaths.add(path);
      done = donePaths.size;
      setMeta("last", new Date().toISOString());
      onProgress?.(done, leaves.length, filled);
      continue;
    }

    const pages = pageCount(html);
    const keys = new Set(parseCompanyKeys(html));
    for (let p = 2; p <= pages; p += 1) {
      if (stopFlag) break;
      html = await fetchHtml(`${firstUrl}${firstUrl.includes("?") ? "&" : "?"}page=${p}`);
      for (const k of parseCompanyKeys(html)) keys.add(k);
    }

    let wrote = 0;
    for (const key of keys) {
      const ticker = resolveScreenerCompanyKey(key);
      if (!ticker) continue;
      upsertRow(ticker, path, labels);
      wrote += 1;
    }
    filled += wrote;
    markLeafDone(path, { status: "done", labels, tickerCount: wrote, resultsFound });
    donePaths.add(path);
    done = donePaths.size;
    setMeta("last", new Date().toISOString());
    onProgress?.(done, leaves.length, filled);
  }

  const left = Math.max(0, leaves.length - donePaths.size);
  if (!stopFlag && left === 0) setMeta("active", "0");

  return {
    tried: done,
    filled,
    left,
    not_found: 0,
  };
}
