import { fetchDailyBars } from "./ohlc";
import { loadMetricsMap, refreshPagePrices } from "./metrics";
import {
  computeDailyRetFf,
  computeReturnsPct,
  resultEntryClose,
} from "./pead-score";
import { savePeadReturns } from "./pead-returns-cache";
import { refreshPeadWebMetrics } from "./pead-web-metrics";
import {
  latestAnnounceOnOrBefore,
  loadPeadAnnounceDatesMap,
  refreshPeadNseResultDates,
} from "./pead-announced";
import { runConcurrent } from "./scrape-pool";
import type { Pead2Row } from "./pead2-types";
import { invalidatePead2TableCache } from "./pead2-table";

function applyLivePrices(rows: Pead2Row[]): void {
  const prices = loadMetricsMap();
  for (const row of rows) {
    const live = prices.get(row.ticker.toUpperCase())?.price;
    if (live != null && Number.isFinite(live) && live > 0) row.price = live;
  }
}

/** Recompute Returns / Daily Ret from OHLC + current row.price (no NSE/web). */
export async function recomputePeadReturnsFromBars(
  rows: Pead2Row[],
  opts?: { concurrency?: number },
): Promise<{ updated: number }> {
  if (!rows.length) return { updated: 0 };
  const concurrency = Math.min(8, Math.max(2, opts?.concurrency ?? 6));
  applyLivePrices(rows);
  let updated = 0;
  await runConcurrent(rows, concurrency, async (row) => {
    const result_date = row.result_date;
    if (!result_date) return;
    const bars = await fetchDailyBars(row.ticker, row.market, 2);
    const closes = bars.map((b) => ({
      date: b.date.slice(0, 10),
      close: b.close,
    }));
    const returns_pct = computeReturnsPct(closes, result_date, row.price);
    const daily_ret_pct = computeDailyRetFf(closes, result_date);
    const entry_close = resultEntryClose(closes, result_date);
    savePeadReturns(
      row.ticker,
      returns_pct,
      daily_ret_pct,
      result_date,
      entry_close,
    );
    row.returns_pct = returns_pct;
    row.daily_ret_pct = daily_ret_pct;
    updated += 1;
  });
  if (updated > 0) invalidatePead2TableCache();
  return { updated };
}

export async function refreshPeadReturns(
  rows: Pead2Row[],
  opts?: { concurrency?: number },
): Promise<{ updated: number }> {
  if (!rows.length) return { updated: 0 };
  const concurrency = Math.min(8, Math.max(2, opts?.concurrency ?? 6));
  // Live quotes first so exit price / displayed Price are not weeks stale.
  await refreshPagePrices(
    rows.map((r) => ({ ticker: r.ticker, market: r.market })),
    { force: true, concurrency: Math.min(8, concurrency) },
  );
  applyLivePrices(rows);
  // Web PE + NSE announcement dates in parallel — independent sources.
  await Promise.all([
    refreshPeadWebMetrics(rows, { concurrency: Math.min(6, concurrency) }),
    refreshPeadNseResultDates(rows, { concurrency: Math.min(4, concurrency) }),
  ]);
  const announceMap = loadPeadAnnounceDatesMap();
  let updated = 0;
  await runConcurrent(rows, concurrency, async (row) => {
    const result_date =
      latestAnnounceOnOrBefore(announceMap.get(row.ticker) ?? []) ||
      row.result_date;
    row.result_date = result_date;
    if (!result_date) return;
    const bars = await fetchDailyBars(row.ticker, row.market, 2);
    const closes = bars.map((b) => ({
      date: b.date.slice(0, 10),
      close: b.close,
    }));
    const returns_pct = computeReturnsPct(closes, result_date, row.price);
    const daily_ret_pct = computeDailyRetFf(closes, result_date);
    const entry_close = resultEntryClose(closes, result_date);
    savePeadReturns(
      row.ticker,
      returns_pct,
      daily_ret_pct,
      result_date,
      entry_close,
    );
    row.returns_pct = returns_pct;
    row.daily_ret_pct = daily_ret_pct;
    updated += 1;
  });
  if (updated > 0) invalidatePead2TableCache();
  return { updated };
}
