/**
 * Corporate actions: old NSE/BSE symbols → current trading symbol.
 * Used for TV / Screener / Yahoo so stale tickers still resolve.
 */
const TICKER_ALIASES: Record<string, string> = {
  /** MIRC Electronics → Onida Electronics (NSE symbol change Jun 2026) */
  MIRCELECTR: "ONIDA",
  MIRC: "ONIDA",
};

export function canonicalTicker(ticker: string | null | undefined): string {
  const sym = (ticker ?? "").trim().toUpperCase();
  if (!sym) return "";
  return TICKER_ALIASES[sym] ?? sym;
}

export function tickerAliasMap(): Readonly<Record<string, string>> {
  return TICKER_ALIASES;
}
