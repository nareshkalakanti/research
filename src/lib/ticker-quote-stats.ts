import { loadMetricsMap } from "@/lib/metrics";

export type TickerQuoteStats = {
  mcap_cr: number | null;
};

function uniqueTickers(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const t = (raw || "").trim().toUpperCase();
    if (!t || t === "—" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Local market cap from metrics.db — no network. */
export function quoteStatsByTickers(
  tickers: Array<string | null | undefined>,
): Map<string, TickerQuoteStats> {
  const keys = uniqueTickers(tickers);
  const out = new Map<string, TickerQuoteStats>();
  if (!keys.length) return out;

  const metrics = loadMetricsMap();
  for (const ticker of keys) {
    const mcap = metrics.get(ticker)?.market_cap_cr;
    out.set(ticker, {
      mcap_cr: mcap != null && mcap > 0 ? mcap : null,
    });
  }
  return out;
}

export function attachTickerQuoteStats<T extends { ticker?: string | null }>(
  rows: T[],
): Array<T & TickerQuoteStats> {
  const stats = quoteStatsByTickers(rows.map((r) => r.ticker));
  return rows.map((row) => {
    const s = stats.get((row.ticker || "").trim().toUpperCase());
    return {
      ...row,
      mcap_cr: s?.mcap_cr ?? null,
    };
  });
}
