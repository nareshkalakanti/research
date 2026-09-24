/** Screener / TradingView / Web link helpers for NSE & BSE. */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { canonicalTicker } from "@/lib/ticker-aliases";
import { DATA_DIR } from "@/lib/sqlite-utils";

const TV_CHART_BASE = "https://www.tradingview.com/chart/";
const NSE_MARKETS = new Set(["NSE", "NSE SME", "NATIONAL STOCK EXCHANGE"]);
const BSE_MARKETS = new Set([
  "BSE",
  "BSE SME",
  "BOMBAY STOCK EXCHANGE",
]);

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function marketLooksBse(mk: string): boolean {
  const u = mk.toUpperCase();
  return BSE_MARKETS.has(u) || u.startsWith("BSE");
}

function marketLooksNse(mk: string): boolean {
  const u = mk.toUpperCase();
  return NSE_MARKETS.has(u) || u.startsWith("NSE");
}

function readMarketColumn(
  file: string,
  sql: string,
  ticker: string,
): string | null {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(p, { readonly: true, fileMustExist: true });
    const row = db.prepare(sql).get(ticker) as { market?: string | null } | undefined;
    const mk = clean(row?.market);
    return mk || null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function hasBseScrip(ticker: string): boolean {
  const p = path.join(DATA_DIR, "company_about.db");
  if (!fs.existsSync(p)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(p, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM company_bse_scrip WHERE UPPER(ticker) = ? LIMIT 1`,
      )
      .get(ticker) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Listing venue from local DBs when the caller omitted market (or passed NSE by default). */
function storedListingMarket(ticker: string): string | null {
  const t = ticker.toUpperCase();
  return (
    readMarketColumn(
      "company_about.db",
      `SELECT market FROM company_about WHERE UPPER(ticker) = ? LIMIT 1`,
      t,
    ) ||
    readMarketColumn(
      "metrics.db",
      `SELECT market FROM stock_metrics WHERE UPPER(ticker) = ? LIMIT 1`,
      t,
    ) ||
    readMarketColumn(
      "holdings.db",
      `SELECT market FROM holdings WHERE UPPER(ticker) = ? LIMIT 1`,
      t,
    ) ||
    readMarketColumn(
      "named_watchlists.db",
      `SELECT market FROM named_watchlists
       WHERE UPPER(ticker) = ? AND TRIM(COALESCE(market, '')) != ''
       LIMIT 1`,
      t,
    ) ||
    (hasBseScrip(t) ? "BSE" : null)
  );
}

export function tradingviewExchange(
  ticker: string,
  market?: string | null,
): "NSE" | "BSE" {
  const hint = clean(market);
  const stored = storedListingMarket(canonicalTicker(ticker) || ticker);
  if (marketLooksBse(hint)) return "BSE";
  // BSE-only names in local DBs must not chart as NSE when the caller omitted
  // market or defaulted it.
  if (stored && marketLooksBse(stored) && !marketLooksNse(stored)) return "BSE";
  if (marketLooksNse(hint)) return "NSE";
  if (stored && marketLooksNse(stored)) return "NSE";
  if (stored && marketLooksBse(stored)) return "BSE";
  return "NSE";
}

/** Unresolved BSE feed placeholder: BSE539760, BSE:539760, or bare 539760. */
export function isBsePlaceholderTicker(
  ticker: string | null | undefined,
): boolean {
  return /^(?:BSE[:\s-]*)?\d{5,7}$/i.test(clean(ticker));
}

/** Numeric scrip from a BSE placeholder ticker, else null. */
export function bseScripCodeFromTicker(
  ticker: string | null | undefined,
): string | null {
  const m = clean(ticker).match(/^(?:BSE[:\s-]*)?(\d{5,7})$/i);
  return m?.[1] ?? null;
}

/** BSE India quote page when we only know the numeric scrip. */
export function bseIndiaQuoteUrl(scripCode: string): string {
  return `https://www.bseindia.com/stock-share-price/stockreach_stock_price.aspx?scripcode=${encodeURIComponent(scripCode.trim())}`;
}

/** Deep-link into Governance map for an 8-digit DIN (person_id). */
export function governanceDinUrl(din: string): string | null {
  const digits = (din || "").replace(/\D/g, "");
  if (digits.length !== 8) return null;
  return `/?tab=governance&personId=${encodeURIComponent(digits)}`;
}

export function tradingviewUrl(
  ticker: string,
  market?: string | null,
): string {
  const sym = canonicalTicker(ticker);
  if (!sym) return TV_CHART_BASE;
  // Never send BSE###### placeholders to TV — they are not chart symbols.
  const scrip = bseScripCodeFromTicker(sym);
  if (scrip) return bseIndiaQuoteUrl(scrip);

  const exchange = tradingviewExchange(sym, market);
  return `${TV_CHART_BASE}?symbol=${encodeURIComponent(`${exchange}:${sym}`)}`;
}

/**
 * Equity chart/quote URL: TradingView when we have a real symbol,
 * BSE India when we only have a numeric scrip placeholder.
 */
export function equityChartUrl(
  ticker: string,
  market?: string | null,
): string {
  return tradingviewUrl(ticker, market);
}

export function screenerUrl(ticker: string): string {
  const sym = canonicalTicker(ticker);
  if (!sym) return "https://www.screener.in/";
  // Screener uses NSE-style symbols; skip placeholders.
  if (isBsePlaceholderTicker(sym)) return "https://www.screener.in/";
  return `https://www.screener.in/company/${sym}/`;
}

/** Consolidated P&L — matches most screeners' default research view. */
export function screenerConsolidatedUrl(ticker: string): string {
  const sym = canonicalTicker(ticker);
  if (!sym) return "https://www.screener.in/";
  return `https://www.screener.in/company/${sym}/consolidated/`;
}

export function screenerConcallsUrl(ticker: string): string {
  const sym = canonicalTicker(ticker);
  if (!sym) return "https://www.screener.in/";
  return `https://www.screener.in/company/${sym}/#documents`;
}

export function websiteUrl(website: string | null | undefined): string | null {
  const w = clean(website);
  if (!w) return null;
  if (/^https?:\/\//i.test(w)) return w;
  return `https://${w}`;
}

export type ResearchLinks = {
  web: string | null;
  sc: string;
  tv: string;
};

export function researchLinks(
  ticker: string,
  market?: string | null,
  website?: string | null,
): ResearchLinks {
  return {
    web: websiteUrl(website),
    sc: screenerUrl(ticker),
    tv: tradingviewUrl(ticker, market),
  };
}
