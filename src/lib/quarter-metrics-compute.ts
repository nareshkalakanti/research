import { loadMetricsMap } from "@/lib/metrics";
import {
  buildQuarterPanel,
  computeCfProfit,
  extraMetricsFromPanel,
  yoyFromPanel,
} from "@/lib/quarter-panel";
import {
  isQuarterMetricsFresh,
  isQuarterMetricsTombstone,
  loadQuarterMetricsMap,
  saveQuarterMetrics,
  tickerNeedsExtrasBackfill,
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

function resolveRowPrice(
  ticker: string,
  priceOverride?: number | null,
): number | null {
  if (
    priceOverride != null &&
    Number.isFinite(priceOverride) &&
    priceOverride > 0
  ) {
    return priceOverride;
  }
  return loadMetricsMap().get(ticker.toUpperCase())?.price ?? null;
}

function needsQuarterRefetch(
  ticker: string,
  map = loadQuarterMetricsMap(),
  force?: boolean,
): boolean {
  if (force) return true;
  const row = map.get(ticker.toUpperCase());
  if (!row) return true;
  if (isQuarterMetricsTombstone(row)) return true;
  if (!isQuarterMetricsFresh(row)) return true;
  if (tickerNeedsExtrasBackfill(ticker, map)) return true;
  return false;
}

/** Load QTR panel + metrics; refetch and heal cache when stale or empty. */
export async function resolveQuarterPanelData(
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
  if (needsQuarterRefetch(key, loadQuarterMetricsMap(), opts?.force)) {
    return computeAndCacheQuarterMetrics(ticker, market, priceOverride, opts);
  }

  const rowPrice = resolveRowPrice(key, priceOverride);

  try {
    const live = await fetchQuarterlyFundamentals(key, market, {
      screenerForce: opts?.force,
    });
    const panel = buildQuarterPanel(live.quarters);
    if (!panel) {
      return computeAndCacheQuarterMetrics(ticker, market, priceOverride, {
        force: true,
      });
    }

    const snapshot = metricsSnapshotFromPanel(
      panel,
      rowPrice,
      computeCfProfit(
        live.operating_cashflow,
        live.quarters.at(-1)?.netIncome ?? null,
      ),
    );
    persistSnapshot(key, snapshot);
    return {
      ok: true,
      snapshot,
      panel,
      price: rowPrice,
      symbol: live.symbol,
      source: live.source,
      fromCache: true,
    };
  } catch {
    return computeAndCacheQuarterMetrics(ticker, market, priceOverride, {
      force: true,
    });
  }
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
    !isQuarterMetricsTombstone(cached) &&
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
      await fetchQuarterlyFundamentals(key, market, {
        screenerForce: opts?.force,
      });
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
    // Transient network/Yahoo errors — do not tombstone; allow immediate retry.
    return { ok: false, snapshot: null, panel: null, price: null };
  }
}
