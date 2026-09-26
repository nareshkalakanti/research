/**
 * Price tape for watchlist expand: SMA 20/50/100/200, 52-week range, PE, CAGR.
 * All figures from Yahoo daily bars / quote — no issuer hardcoding.
 */
import { fetchDailyBars } from "./ohlc";
import { rollingMean } from "./indicators";
import { yfSymbolCandidates } from "./yfinance";
import YahooFinance from "yahoo-finance2";
import { loadQuarterMetricsMap } from "./quarter-metrics-cache";
import { computeReturnsPct } from "./pead-score";

const yf = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  validation: { logErrors: false, logOptionsErrors: false },
});

export type QuoteTapeMa = {
  period: 20 | 50 | 100 | 200;
  value: number | null;
  above: boolean | null;
};

export type QuoteTape = {
  price: number | null;
  prev_close: number | null;
  pe: number | null;
  cagr_pct: number | null;
  cagr_years: number | null;
  week52_low: number | null;
  week52_high: number | null;
  dma200: number | null;
  breakout20: number | null;
  dma200_alert: "below_200_breakout" | null;
  mas: QuoteTapeMa[];
  returns_pct: number | null;
  result_date: string | null;
};

function lastMean(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const series = rollingMean(closes, period);
  const v = series[series.length - 1];
  return v != null && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function round2(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function quotePeAndRange(
  ticker: string,
  market: string | null | undefined,
): Promise<{ pe: number | null; low: number | null; high: number | null }> {
  const out = { pe: null as number | null, low: null as number | null, high: null as number | null };
  for (const sym of yfSymbolCandidates(ticker, market).slice(0, 2)) {
    try {
      const q = await yf.quote(sym);
      const pe =
        num((q as { trailingPE?: unknown }).trailingPE) ??
        num((q as { trailingPe?: unknown }).trailingPe);
      const low = num((q as { fiftyTwoWeekLow?: unknown }).fiftyTwoWeekLow);
      const high = num((q as { fiftyTwoWeekHigh?: unknown }).fiftyTwoWeekHigh);
      if (pe != null && pe > 0) out.pe = round2(pe);
      if (low != null) out.low = round2(low);
      if (high != null) out.high = round2(high);
      if (out.pe != null || (out.low != null && out.high != null)) return out;
    } catch {
      /* next symbol */
    }
  }
  return out;
}

export async function loadQuoteTape(
  ticker: string,
  market?: string | null,
): Promise<QuoteTape> {
  const empty: QuoteTape = {
    price: null,
    prev_close: null,
    pe: null,
    cagr_pct: null,
    cagr_years: null,
    week52_low: null,
    week52_high: null,
    dma200: null,
    breakout20: null,
    dma200_alert: null,
    mas: [
      { period: 20, value: null, above: null },
      { period: 50, value: null, above: null },
      { period: 100, value: null, above: null },
      { period: 200, value: null, above: null },
    ],
    returns_pct: null,
    result_date: null,
  };
  const t = ticker.trim().toUpperCase();
  if (!t) return empty;

  const [bars, quote] = await Promise.all([
    fetchDailyBars(t, market, 4),
    quotePeAndRange(t, market),
  ]);
  const closes = bars.map((b) => b.close).filter((c) => Number.isFinite(c));
  const price = closes.length ? round2(closes[closes.length - 1]!) : null;
  const prev_close = closes.length > 1 ? round2(closes[closes.length - 2]!) : null;

  const mas: QuoteTapeMa[] = ([20, 50, 100, 200] as const).map((period) => {
    const value = lastMean(closes, period);
    return {
      period,
      value,
      above: price != null && value != null ? price >= value : null,
    };
  });
  const dma200 = mas.find((m) => m.period === 200)?.value ?? null;
  const breakout20 =
    bars.length > 1
      ? round2(Math.max(...bars.slice(-21, -1).map((b) => b.high)))
      : null;
  const dma200_alert =
    price != null &&
    dma200 != null &&
    breakout20 != null &&
    price < dma200 &&
    price > breakout20 &&
    prev_close != null &&
    prev_close <= breakout20
      ? "below_200_breakout"
      : null;

  let week52_low = quote.low;
  let week52_high = quote.high;
  const yearBars = bars.slice(-252);
  if (yearBars.length >= 40) {
    const lows = yearBars.map((b) => b.low);
    const highs = yearBars.map((b) => b.high);
    const lo = Math.min(...lows);
    const hi = Math.max(...highs);
    if (week52_low == null) week52_low = round2(lo);
    if (week52_high == null) week52_high = round2(hi);
  }

  let cagr_pct: number | null = null;
  let cagr_years: number | null = null;
  if (bars.length >= 400) {
    const first = bars[0]!.close;
    const last = bars[bars.length - 1]!.close;
    const years =
      (Date.parse(bars[bars.length - 1]!.date) - Date.parse(bars[0]!.date)) /
      (365.25 * 24 * 3600 * 1000);
    if (first > 0 && last > 0 && years >= 2) {
      cagr_years = Math.round(years * 10) / 10;
      cagr_pct =
        Math.round((Math.pow(last / first, 1 / years) - 1) * 1000) / 10;
    }
  }

  let result_date: string | null = null;
  try {
    result_date = loadQuarterMetricsMap().get(t)?.result_date ?? null;
  } catch {
    result_date = null;
  }
  const returns_pct = computeReturnsPct(
    bars.map((b) => ({ date: b.date, close: b.close })),
    result_date,
    price,
  );

  return {
    price,
    prev_close,
    pe: quote.pe,
    cagr_pct,
    cagr_years,
    week52_low,
    week52_high,
    dma200,
    breakout20,
    dma200_alert,
    mas,
    returns_pct,
    result_date,
  };
}
