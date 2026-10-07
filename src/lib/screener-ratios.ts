/**
 * Screener.in company top-ratios (Market Cap, Stock P/E, ROE, ROCE).
 * Used when Yahoo omits current levels (common for NSE SME).
 */
import * as cheerio from "cheerio";
import { fetchScreenerCompanyHtml } from "./screener-fetch";
import { openSqliteNamed } from "./sqlite-utils";

const CACHE_MS = 24 * 60 * 60 * 1000;

export type ScreenerTopRatios = {
  market_cap_cr: number | null;
  stock_pe: number | null;
  /** Ratio (0.589), not percent points. */
  roce: number | null;
  /** Ratio (0.549), not percent points. */
  roe: number | null;
  current_price: number | null;
};

type CacheRow = {
  ratios_json: string;
  fetched_at: string;
};

function ensureCacheSchema(): void {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS screener_ratios_cache (
        ticker TEXT PRIMARY KEY,
        ratios_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);
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

function emptyRatios(): ScreenerTopRatios {
  return {
    market_cap_cr: null,
    stock_pe: null,
    roce: null,
    roe: null,
    current_price: null,
  };
}

function ratiosUsable(r: ScreenerTopRatios): boolean {
  return (
    r.market_cap_cr != null ||
    r.stock_pe != null ||
    r.roe != null ||
    r.roce != null ||
    r.current_price != null
  );
}

/** Parse `#top-ratios` from a Screener company page. */
export function parseScreenerTopRatios(html: string): ScreenerTopRatios {
  const out = emptyRatios();
  if (!html || /captcha|access denied|rate limit/i.test(html)) return out;

  const $ = cheerio.load(html);
  $("#top-ratios li").each((_, el) => {
    const $li = $(el);
    const label = $li.find("span.name").first().text().replace(/\s+/g, " ").trim();
    const numEl = $li.find("span.number").first();
    const val = parseNum(numEl.text() || "");
    if (val == null) return;
    const key = label.toLowerCase();
    if (key === "market cap") out.market_cap_cr = val;
    else if (key === "stock p/e" || key === "stock pe") out.stock_pe = val;
    else if (key === "roce") out.roce = val / 100;
    else if (key === "roe") out.roe = val / 100;
    else if (key === "current price") out.current_price = val;
  });
  return out;
}

function readCache(ticker: string): ScreenerTopRatios | null {
  ensureCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const row = db
      .prepare(
        `SELECT ratios_json, fetched_at FROM screener_ratios_cache WHERE ticker = ?`,
      )
      .get(ticker.toUpperCase()) as CacheRow | undefined;
    if (!row) return null;
    if (Date.now() - Date.parse(row.fetched_at) >= CACHE_MS) return null;
    const parsed = JSON.parse(row.ratios_json) as ScreenerTopRatios;
    return ratiosUsable(parsed) ? parsed : null;
  } finally {
    db.close();
  }
}

function writeCache(ticker: string, ratios: ScreenerTopRatios): void {
  if (!ratiosUsable(ratios)) return;
  ensureCacheSchema();
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO screener_ratios_cache (ticker, ratios_json, fetched_at)
       VALUES (@ticker, @ratios_json, @fetched_at)
       ON CONFLICT(ticker) DO UPDATE SET
         ratios_json = excluded.ratios_json,
         fetched_at = excluded.fetched_at`,
    ).run({
      ticker: ticker.toUpperCase(),
      ratios_json: JSON.stringify(ratios),
      fetched_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

/** Top ratios from Screener company page (consolidated, then standalone). */
export async function fetchScreenerTopRatios(
  ticker: string,
  opts?: { force?: boolean },
): Promise<ScreenerTopRatios> {
  const key = ticker.trim().toUpperCase();
  if (!key) return emptyRatios();

  if (!opts?.force) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  try {
    let ratios = parseScreenerTopRatios(
      await fetchScreenerCompanyHtml(key, { consolidated: true }),
    );
    if (!ratiosUsable(ratios)) {
      try {
        const stand = parseScreenerTopRatios(
          await fetchScreenerCompanyHtml(key, { consolidated: false }),
        );
        if (ratiosUsable(stand)) ratios = stand;
      } catch {
        /* keep first parse */
      }
    }
    writeCache(key, ratios);
    return ratios;
  } catch {
    return emptyRatios();
  }
}
