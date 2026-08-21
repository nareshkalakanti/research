import { loadMetricsMap } from "@/lib/metrics";
import { buildQuarterPanel, yoyFromPanel } from "@/lib/quarter-panel";
import {
  isQuarterMetricsFresh,
  loadQuarterMetricsMap,
  saveQuarterMetrics,
  tickerNeedsQuarterScan,
  type QuarterMetricsRow,
} from "@/lib/quarter-metrics-cache";
import { computeForwardPe, epsFromQuarterPanel } from "@/lib/valuation";
import { fetchQuarterlyFundamentals } from "@/lib/yahoo-quarters";

export type QuarterMetricsSnapshot = {
  forward_pe: number | null;
  eps_yoy: number | null;
  sales_yoy: number | null;
  np_yoy: number | null;
};

function snapshotFromRow(row: QuarterMetricsRow): QuarterMetricsSnapshot {
  return {
    forward_pe: row.forward_pe,
    eps_yoy: row.eps_yoy,
    sales_yoy: row.sales_yoy,
    np_yoy: row.np_yoy,
  };
}

function saveTombstone(ticker: string): void {
  saveQuarterMetrics(ticker, {
    forward_pe: null,
    eps_yoy: null,
    sales_yoy: null,
    np_yoy: null,
  });
}

export async function computeAndCacheQuarterMetrics(
  ticker: string,
  market: string | null,
  priceOverride?: number | null,
  opts?: { force?: boolean },
): Promise<{
  ok: boolean;
  snapshot: QuarterMetricsSnapshot | null;
  panel: ReturnType<typeof buildQuarterPanel>;
  price: number | null;
  symbol?: string;
  source?: string;
  fromCache?: boolean;
}> {
  const key = ticker.toUpperCase();
  const cached = loadQuarterMetricsMap().get(key);
  if (!opts?.force && cached && isQuarterMetricsFresh(cached)) {
    return {
      ok: true,
      snapshot: snapshotFromRow(cached),
      panel: null,
      price: priceOverride ?? loadMetricsMap().get(key)?.price ?? null,
      fromCache: true,
    };
  }

  try {
    const { quarters, price: yahooPrice, symbol, source } =
      await fetchQuarterlyFundamentals(key, market);
    const panel = buildQuarterPanel(quarters);
    if (!panel) {
      saveTombstone(key);
      return {
        ok: true,
        snapshot: null,
        panel: null,
        price: null,
        symbol,
        source,
      };
    }

    const metrics = loadMetricsMap();
    const priceRow = metrics.get(key);
    let price =
      priceOverride != null &&
      Number.isFinite(priceOverride) &&
      priceOverride > 0
        ? priceOverride
        : (yahooPrice ?? priceRow?.price ?? null);

    const eps = epsFromQuarterPanel(panel);
    const forwardPe = price ? computeForwardPe(price, eps) : null;
    const yoy = yoyFromPanel(panel);
    const snapshot: QuarterMetricsSnapshot = {
      forward_pe: forwardPe,
      eps_yoy: yoy?.eps_yoy ?? null,
      sales_yoy: yoy?.sales_yoy ?? null,
      np_yoy: yoy?.np_yoy ?? null,
    };
    saveQuarterMetrics(key, snapshot);
    return { ok: true, snapshot, panel, price, symbol, source };
  } catch {
    saveTombstone(key);
    return { ok: false, snapshot: null, panel: null, price: null };
  }
}

export function tickersMissingQuarterMetrics(tickers: string[]): Set<string> {
  const map = loadQuarterMetricsMap();
  const missing = new Set<string>();
  for (const raw of tickers) {
    const t = raw.toUpperCase();
    if (tickerNeedsQuarterScan(t, map)) missing.add(t);
  }
  return missing;
}

export function countMissingQuarterMetrics(tickers: string[]): number {
  return tickersMissingQuarterMetrics(tickers).size;
}

export async function runQuarterMetricsBatch(
  items: Array<{ ticker: string; market: string }>,
  opts?: { concurrency?: number },
): Promise<{ tried: number; saved: number; failed: number; skipped: number }> {
  const map = loadQuarterMetricsMap();
  const pending = items.filter((item) =>
    tickerNeedsQuarterScan(item.ticker, map),
  );
  const skipped = items.length - pending.length;

  const concurrency = Math.min(6, Math.max(1, opts?.concurrency ?? 4));
  let tried = 0;
  let saved = 0;
  let failed = 0;
  let i = 0;

  async function worker() {
    while (i < pending.length) {
      const idx = i;
      i += 1;
      const item = pending[idx]!;
      tried += 1;
      const metrics = loadMetricsMap();
      const price = metrics.get(item.ticker.toUpperCase())?.price ?? null;
      const result = await computeAndCacheQuarterMetrics(
        item.ticker,
        item.market,
        price,
      );
      if (result.ok) saved += 1;
      else failed += 1;
    }
  }

  if (pending.length) {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, pending.length) }, () =>
        worker(),
      ),
    );
  }
  return { tried, saved, failed, skipped };
}
