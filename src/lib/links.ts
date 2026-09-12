/** Screener / TradingView / Web link helpers for NSE & BSE. */

import { canonicalTicker } from "@/lib/ticker-aliases";

const TV_CHART_BASE = "https://www.tradingview.com/chart/";
const NSE_MARKETS = new Set(["NSE", "NSE SME", "NATIONAL STOCK EXCHANGE"]);
const BSE_MARKETS = new Set([
  "BSE",
  "BSE SME",
  "BOMBAY STOCK EXCHANGE",
]);

/**
 * BSE-only names that are sometimes stored as NSE in company_about.
 * TradingView has no NSE:SYMBOL for these — use BSE:SYMBOL.
 */
const TV_BSE_ONLY = new Set([
  "ASMTEC", // ASM Technologies Ltd — BSE 526433
  "EMERALD", // Emerald Finance — BSE-only on TV
  "FLUIDOM", // Fluidomat — BSE-only on TV
  "SERA", // Sera Investments — BSE-only on TV
  "SIMPLEXCAS", // Simplex Castings — BSE-only on TV
  "SOBME", // Sobhagya Mercantile — BSE-only on TV
]);

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
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
  const mk = clean(market).toUpperCase();
  let exchange: "NSE" | "BSE" = "NSE";
  if (TV_BSE_ONLY.has(sym) || BSE_MARKETS.has(mk)) {
    exchange = "BSE";
  } else if (NSE_MARKETS.has(mk) || !mk) {
    exchange = "NSE";
  } else {
    exchange = "BSE";
  }
  return `${TV_CHART_BASE}?symbol=${encodeURIComponent(`${exchange}:${sym}`)}`;
}

export function screenerUrl(ticker: string): string {
  const sym = canonicalTicker(ticker);
  if (!sym) return "https://www.screener.in/";
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
