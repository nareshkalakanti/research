/** Screener / TradingView / Web link helpers for NSE & BSE. */

import { canonicalTicker } from "@/lib/ticker-aliases";

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

  const mk = clean(market).toUpperCase();
  let exchange: "NSE" | "BSE" = "NSE";
  if (BSE_MARKETS.has(mk)) {
    exchange = "BSE";
  } else if (NSE_MARKETS.has(mk) || !mk) {
    exchange = "NSE";
  } else if (mk.startsWith("BSE")) {
    exchange = "BSE";
  }
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
