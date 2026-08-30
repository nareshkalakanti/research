/** Screener / TradingView / Web link helpers for NSE & NSE SME. */

const TV_CHART_BASE = "https://www.tradingview.com/chart/";
const NSE_MARKETS = new Set(["NSE", "NSE SME", "NATIONAL STOCK EXCHANGE"]);

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function tradingviewUrl(
  ticker: string,
  market?: string | null,
): string {
  const sym = clean(ticker).toUpperCase();
  if (!sym) return TV_CHART_BASE;
  const mk = clean(market).toUpperCase();
  const exchange = NSE_MARKETS.has(mk) || !mk ? "NSE" : "BSE";
  return `${TV_CHART_BASE}?symbol=${encodeURIComponent(`${exchange}:${sym}`)}`;
}

export function screenerUrl(ticker: string): string {
  const sym = clean(ticker).toUpperCase();
  if (!sym) return "https://www.screener.in/";
  return `https://www.screener.in/company/${sym}/`;
}

export function screenerConcallsUrl(ticker: string): string {
  const sym = clean(ticker).toUpperCase();
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
