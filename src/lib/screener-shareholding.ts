/**
 * Screener.in shareholding pattern for Management Score.
 */
import * as cheerio from "cheerio";
import { fetchScreenerCompanyHtml } from "./screener-fetch";
import {
  parseScreenerSectionTable,
  pickScreenerRow,
} from "./screener-annual";
import { openSqliteNamed } from "./sqlite-utils";

const CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const BLOCK_MS = 6 * 60 * 60 * 1000;

export type ScreenerShareholding = {
  dates: string[];
  promoters: Array<number | null>;
  fii: Array<number | null>;
  dii: Array<number | null>;
  public: Array<number | null>;
  shareholders: Array<number | null>;
  /** Latest promoter pledge % when disclosed (0 = none). */
  pledged_pct: number | null;
};

type CacheRow = {
  sh_json: string;
  fetched_at: string;
  blocked_until: string | null;
};

function empty(): ScreenerShareholding {
  return {
    dates: [],
    promoters: [],
    fii: [],
    dii: [],
    public: [],
    shareholders: [],
    pledged_pct: null,
  };
}

function ensureSchema(): void {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS screener_shareholding_cache (
        ticker TEXT PRIMARY KEY,
        sh_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        blocked_until TEXT
      );
    `);
  } finally {
    db.close();
  }
}

function readCache(ticker: string): ScreenerShareholding | "blocked" | null {
  ensureSchema();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const row = db
      .prepare(
        `SELECT sh_json, fetched_at, blocked_until FROM screener_shareholding_cache WHERE ticker = ?`,
      )
      .get(ticker.toUpperCase()) as CacheRow | undefined;
    if (!row) return null;
    if (row.blocked_until && Date.parse(row.blocked_until) > Date.now()) {
      return "blocked";
    }
    if (Date.now() - Date.parse(row.fetched_at) < CACHE_MS) {
      return JSON.parse(row.sh_json) as ScreenerShareholding;
    }
    return null;
  } finally {
    db.close();
  }
}

function writeCache(
  ticker: string,
  series: ScreenerShareholding,
  blockedUntil?: string | null,
): void {
  ensureSchema();
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO screener_shareholding_cache (ticker, sh_json, fetched_at, blocked_until)
       VALUES (@ticker, @sh_json, @fetched_at, @blocked_until)
       ON CONFLICT(ticker) DO UPDATE SET
         sh_json = excluded.sh_json,
         fetched_at = excluded.fetched_at,
         blocked_until = excluded.blocked_until`,
    ).run({
      ticker: ticker.toUpperCase(),
      sh_json: JSON.stringify(series),
      fetched_at: new Date().toISOString(),
      blocked_until: blockedUntil ?? null,
    });
  } finally {
    db.close();
  }
}

function align(
  n: number,
  vals: Array<number | null> | null,
): Array<number | null> {
  return (vals ?? Array(n).fill(null)).slice(0, n);
}

function parsePledgeFromHtml(html: string): number | null {
  const m = html.match(
    /pledged[^%]{0,80}?(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%[^%]{0,40}?pledged/i,
  );
  if (!m) {
    if (/no\s+pledged|pledged\s*[:=]\s*0|pledged.*?none/i.test(html)) return 0;
    return null;
  }
  const n = Number(m[1] || m[2]);
  return Number.isFinite(n) ? n : null;
}

export function parseScreenerShareholdingHtml(html: string): ScreenerShareholding {
  const out = empty();
  if (/captcha|access denied|rate limit/i.test(html)) return out;
  const $ = cheerio.load(html);
  const section = parseScreenerSectionTable($, "shareholding");
  if (!section?.dates.length) return out;
  const n = section.dates.length;
  const promoters = pickScreenerRow(section.rows, [/^Promoters?\b/i]);
  const fii = pickScreenerRow(section.rows, [/^FIIs?\b/i, /^FPI\b/i]);
  const dii = pickScreenerRow(section.rows, [/^DIIs?\b/i]);
  const pub = pickScreenerRow(section.rows, [/^Public\b/i]);
  const holders = pickScreenerRow(section.rows, [
    /^No\.?\s*of\s*Shareholders\b/i,
    /^Number of Shareholders\b/i,
  ]);
  let pledged = parsePledgeFromHtml(html);
  // Screener often omits pledge row when 0 — treat usable promoter series as 0 pledge.
  if (pledged == null && promoters?.some((v) => v != null)) pledged = 0;

  return {
    dates: section.dates.slice(0, n),
    promoters: align(n, promoters),
    fii: align(n, fii),
    dii: align(n, dii),
    public: align(n, pub),
    shareholders: align(n, holders),
    pledged_pct: pledged,
  };
}

function usable(s: ScreenerShareholding): boolean {
  return s.promoters.some((v) => v != null) || s.shareholders.some((v) => v != null);
}

export async function fetchScreenerShareholding(
  ticker: string,
  opts?: { force?: boolean },
): Promise<ScreenerShareholding> {
  const key = ticker.trim().toUpperCase();
  if (!key) return empty();

  if (!opts?.force) {
    const cached = readCache(key);
    if (cached === "blocked") return empty();
    if (cached && usable(cached)) return cached;
  }

  try {
    const html = await fetchScreenerCompanyHtml(key, { consolidated: true });
    const series = parseScreenerShareholdingHtml(html);
    if (usable(series)) writeCache(key, series);
    return series;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/blocked|429|403|captcha/i.test(msg)) {
      writeCache(key, empty(), new Date(Date.now() + BLOCK_MS).toISOString());
    }
    return empty();
  }
}
