import { loadMetricsMap } from "@/lib/metrics";
import { buildQuarterPanel } from "@/lib/quarter-panel";
import { loadCachedScreenerQuartersMap } from "@/lib/screener-quarters";
import { loadHtIvMap } from "@/lib/strategy/ht-store";
import { computeTrailingPe, epsFromQuarterPanel } from "@/lib/valuation";

export type TickerQuoteStats = {
  mcap_cr: number | null;
  pe_ttm: number | null;
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

/** Local TTM PE + mcap from metrics, Screener EPS cache, then Scan PE cache. */
export function quoteStatsByTickers(
  tickers: Array<string | null | undefined>,
): Map<string, TickerQuoteStats> {
  const keys = uniqueTickers(tickers);
  const out = new Map<string, TickerQuoteStats>();
  if (!keys.length) return out;

  const metrics = loadMetricsMap();
  const ht = loadHtIvMap();
  const quarters = loadCachedScreenerQuartersMap(keys);

  for (const ticker of keys) {
    const m = metrics.get(ticker);
    const h = ht.get(ticker);
    const mcap =
      m?.market_cap_cr != null && m.market_cap_cr > 0
        ? m.market_cap_cr
        : h?.market_cap_cr != null && h.market_cap_cr > 0
          ? h.market_cap_cr
          : null;
    const price = m?.price ?? h?.price ?? null;
    const panel = buildQuarterPanel(quarters.get(ticker) ?? []);
    const fromEps = panel
      ? computeTrailingPe(price, epsFromQuarterPanel(panel))
      : null;
    const pe =
      fromEps != null && Number.isFinite(fromEps)
        ? fromEps
        : h?.pe_ratio != null && Number.isFinite(h.pe_ratio)
          ? h.pe_ratio
          : null;
    out.set(ticker, { mcap_cr: mcap, pe_ttm: pe });
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
      pe_ttm: s?.pe_ttm ?? null,
    };
  });
}
