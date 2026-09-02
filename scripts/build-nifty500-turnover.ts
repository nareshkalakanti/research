/**
 * Build Nifty 500 aggregate monthly cash turnover (₹ thousand crore) from Yahoo monthly bars.
 * Run: npx tsx scripts/build-nifty500-turnover.ts
 */
import { fetchNifty500Tickers } from "../src/lib/market/nifty500-constituents";
import {
  croreToKcr,
  movingAvgKcr,
  saveNifty500TurnoverSeries,
  turnoverCr,
  type Nifty500TurnoverSeries,
} from "../src/lib/market/nifty500-turnover";
import { fetchMonthlyBars } from "../src/lib/ohlc";
import { runConcurrent } from "../src/lib/scrape-pool";

const YEARS_BACK = 17;
const MA_WINDOW = 12;

async function main() {
  console.log("Fetching Nifty 500 constituents from NSE…");
  const tickers = await fetchNifty500Tickers();
  console.log(`Constituents: ${tickers.length}`);

  const byMonth = new Map<string, number>();
  let ok = 0;
  let fail = 0;

  await runConcurrent(tickers, 4, async (ticker) => {
    try {
      const bars = await fetchMonthlyBars(ticker, "NSE", YEARS_BACK);
      if (!bars.length) {
        fail += 1;
        return false;
      }
      for (const bar of bars) {
        const month = bar.date.slice(0, 7);
        if (!month || month.length < 7) continue;
        const cr = turnoverCr(bar.close, bar.volume);
        byMonth.set(month, (byMonth.get(month) ?? 0) + cr);
      }
      ok += 1;
      return true;
    } catch {
      fail += 1;
      return false;
    }
  });

  const raw = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, cr]) => ({ month, volume_kcr: croreToKcr(cr) }));

  const series = movingAvgKcr(raw, MA_WINDOW);
  const latest = series[series.length - 1]!;

  const payload: Nifty500TurnoverSeries = {
    built_at: new Date().toISOString(),
    constituents: tickers.length,
    years_back: YEARS_BACK,
    series,
    latest: {
      month: latest.month,
      volume_kcr: latest.volume_kcr,
      ma_kcr: latest.ma_kcr,
    },
  };

  saveNifty500TurnoverSeries(payload);
  console.log(
    `Done · ${ok} ok · ${fail} failed · ${series.length} months · latest ${latest.month} vol ${latest.volume_kcr.toFixed(2)} K cr · MA ${latest.ma_kcr?.toFixed(2) ?? "—"}`,
  );
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
