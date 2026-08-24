import { loadMetricsMap } from "@/lib/metrics";
import {
  buildQuarterPanel,
  computeCfProfit,
  extraMetricsFromPanel,
  yoyFromPanel,
} from "@/lib/quarter-panel";
import {
  isQuarterMetricsFresh,
  loadQuarterMetricsMap,
  saveQuarterMetrics,
  tickerNeedsExtrasBackfill,
  tickerNeedsMetricsRefresh,
  type QuarterMetricsRow,
} from "@/lib/quarter-metrics-cache";
import { computeForwardPe, epsFromQuarterPanel } from "@/lib/valuation";
import { fetchQuarterlyFundamentals } from "@/lib/yahoo-quarters";

import type { QuarterExtraMetrics } from "@/lib/quarter-panel";

export type QuarterMetricsSnapshot = {
  forward_pe: number | null;
  eps_yoy: number | null;
  sales_yoy: number | null;
  np_yoy: number | null;
  extras?: QuarterExtraMetrics | null;
};

function snapshotFromRow(row: QuarterMetricsRow): QuarterMetricsSnapshot {
  return {
    forward_pe: row.forward_pe,
    eps_yoy: row.eps_yoy,
    sales_yoy: row.sales_yoy,
    np_yoy: row.np_yoy,
    extras: {
      sales_qoq: row.sales_qoq,
      np_qoq: row.np_qoq,
      eps_qoq: row.eps_qoq,
      ebidt_yoy: row.ebidt_yoy,
      cf_profit: row.cf_profit,
    },
  };
}

export function metricsSnapshotFromPanel(
  panel: NonNullable<ReturnType<typeof buildQuarterPanel>>,
  price: number | null,
  cfProfit?: number | null,
): QuarterMetricsSnapshot {
  const eps = epsFromQuarterPanel(panel);
  const forwardPe = price ? computeForwardPe(price, eps) : null;
  const yoy = yoyFromPanel(panel);
  const extras = extraMetricsFromPanel(panel, cfProfit);
  return {
    forward_pe: forwardPe,
    eps_yoy: yoy?.eps_yoy ?? null,
    sales_yoy: yoy?.sales_yoy ?? null,
    np_yoy: yoy?.np_yoy ?? null,
    extras,
  };
}

function saveTombstone(ticker: string): void {
  saveQuarterMetrics(ticker, {
    forward_pe: null,
    eps_yoy: null,
    sales_yoy: null,
    np_yoy: null,
    sales_qoq: null,
    np_qoq: null,
    eps_qoq: null,
    ebidt_yoy: null,
    cf_profit: null,
  });
}

function persistSnapshot(ticker: string, snapshot: QuarterMetricsSnapshot): void {
  saveQuarterMetrics(ticker, {
    forward_pe: snapshot.forward_pe,
    eps_yoy: snapshot.eps_yoy,
    sales_yoy: snapshot.sales_yoy,
    np_yoy: snapshot.np_yoy,
    sales_qoq: snapshot.extras?.sales_qoq ?? null,
    np_qoq: snapshot.extras?.np_qoq ?? null,
    eps_qoq: snapshot.extras?.eps_qoq ?? null,
    ebidt_yoy: snapshot.extras?.ebidt_yoy ?? null,
    cf_profit: snapshot.extras?.cf_profit ?? null,
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
  const metricsMap = loadQuarterMetricsMap();
  const cached = metricsMap.get(key);
  if (
    !opts?.force &&
    cached &&
    isQuarterMetricsFresh(cached) &&
    !tickerNeedsExtrasBackfill(key, metricsMap)
  ) {
    return {
      ok: true,
      snapshot: snapshotFromRow(cached),
      panel: null,
      price: priceOverride ?? loadMetricsMap().get(key)?.price ?? null,
      fromCache: true,
    };
  }

  try {
    const { quarters, price: yahooPrice, symbol, source, operating_cashflow } =
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

    const latestNp = quarters[quarters.length - 1]?.netIncome ?? null;
    const cfProfit = computeCfProfit(operating_cashflow, latestNp);
    const snapshot = metricsSnapshotFromPanel(panel, price, cfProfit);
    persistSnapshot(key, snapshot);
    return { ok: true, snapshot, panel, price, symbol, source };
  } catch {
    saveTombstone(key);
    return { ok: false, snapshot: null, panel: null, price: null };
  }
}
