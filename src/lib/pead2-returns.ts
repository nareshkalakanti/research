import { fetchDailyBars } from "./ohlc";
import { computeDailyRetFf, computeReturnsPct } from "./pead-score";
import { savePeadReturns } from "./pead-returns-cache";
import { refreshPeadWebMetrics } from "./pead-web-metrics";
import {
  latestAnnounceOnOrBefore,
  loadPeadAnnounceDatesMap,
  refreshPeadNseResultDates,
} from "./pead-announced";
import { runConcurrent } from "./scrape-pool";
import type { Pead2Row } from "./pead2-types";

export async function refreshPeadReturns(
  rows: Pead2Row[],
  opts?: { concurrency?: number },
): Promise<{ updated: number }> {
  if (!rows.length) return { updated: 0 };
  const concurrency = Math.min(8, Math.max(2, opts?.concurrency ?? 6));
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
    savePeadReturns(row.ticker, returns_pct, daily_ret_pct, result_date);
    row.returns_pct = returns_pct;
    row.daily_ret_pct = daily_ret_pct;
    updated += 1;
  });
  return { updated };
}
