import YahooFinance from "yahoo-finance2";
import type { Bar } from "./indicators";
import { toYfinanceSymbol, yfSymbolCandidates } from "./yfinance";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const NIFTY_SYMBOLS = ["^NSEI", "^NSEBANK"]; // fallback unused for now — ^NSEI first

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * NSE week = Mon–Fri. Stamp weekly signals with that week's Friday.
 * Yahoo weekly bars are usually Sunday week-starts → Friday = Sun+5
 * (e.g. 2026-08-02 → 2026-08-07). Sat labels → that week's Friday.
 */
export function toTradingWeekFriday(isoDate: string): string {
  const raw = (isoDate || "").slice(0, 10);
  const d = new Date(`${raw}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return raw;
  const day = d.getUTCDay(); // 0=Sun … 5=Fri 6=Sat
  const fri = new Date(d);
  if (day === 0) fri.setUTCDate(fri.getUTCDate() + 5);
  else if (day === 6) fri.setUTCDate(fri.getUTCDate() - 1);
  else fri.setUTCDate(fri.getUTCDate() + (5 - day));
  return toDateStr(fri);
}

function periodStart(yearsBack: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - yearsBack);
  return toDateStr(d);
}

/**
 * Yahoo often appends an in-progress stub week (e.g. Fri 07/08 after Sun 02/08,
 * gap < 6 days, often volume 0 / same close). That stub turns last week's
 * BB NEW into ABOVE_BAND — drop it and keep the last completed weekly bar.
 *
 * Mid-week the last bar is also the current week (Sun→Fri stamp still in the
 * future). Drop that too so TQ/BB use the last finished Friday session.
 */
function normalizeWeeklyBars(bars: Bar[]): Bar[] {
  if (bars.length < 2) return bars;
  let out = bars;
  const last = out[out.length - 1];
  const prev = out[out.length - 2];
  if (last.date.slice(0, 10) === prev.date.slice(0, 10)) {
    out = out.slice(0, -1);
  } else {
    const lastTs = Date.parse(`${last.date}T00:00:00Z`);
    const prevTs = Date.parse(`${prev.date}T00:00:00Z`);
    if (Number.isFinite(lastTs) && Number.isFinite(prevTs)) {
      const gapDays = (lastTs - prevTs) / 86_400_000;
      if (gapDays < 6) out = out.slice(0, -1);
    }
  }
  if (out.length < 2) return out;
  const tip = out[out.length - 1];
  const tipFri = toTradingWeekFriday(tip.date);
  const today = toDateStr(new Date());
  if (tipFri > today) return out.slice(0, -1);
  return out;
}

/** Drop in-progress monthly stub (gap < 25 days from prior bar, or current month). */
function normalizeMonthlyBars(bars: Bar[]): Bar[] {
  if (bars.length < 2) return bars;
  let out = bars;
  const last = out[out.length - 1];
  const prev = out[out.length - 2];
  const lastTs = Date.parse(`${last.date.slice(0, 10)}T00:00:00Z`);
  const prevTs = Date.parse(`${prev.date.slice(0, 10)}T00:00:00Z`);
  if (Number.isFinite(lastTs) && Number.isFinite(prevTs)) {
    const gapDays = (lastTs - prevTs) / 86_400_000;
    if (gapDays < 25) out = out.slice(0, -1);
  }
  if (out.length < 2) return out;
  // Yahoo labels the open month with "today" (e.g. 2026-08-25). Drop until month closes.
  const tipMonth = out[out.length - 1].date.slice(0, 7);
  const todayMonth = toDateStr(new Date()).slice(0, 7);
  if (tipMonth >= todayMonth) return out.slice(0, -1);
  return out;
}

function mapChartBars(
  quotes: Array<{
    date?: Date;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    close?: number | null;
    volume?: number | null;
  }>,
): Bar[] {
  return quotes
    .filter(
      (q) =>
        q.date &&
        q.close != null &&
        q.high != null &&
        q.low != null &&
        q.open != null,
    )
    .map((q) => ({
      date: toDateStr(new Date(q.date!)),
      open: Number(q.open),
      high: Number(q.high),
      low: Number(q.low),
      close: Number(q.close),
      volume: Number(q.volume ?? 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Try NSE / SME / BSE Yahoo aliases; keep the series with the most bars.
 * Prefer the primary SME `-SM.NS` series when it has enough history so we
 * don't silently switch to a ghost `.NS` listing with a different price.
 */
async function fetchBarsWithCandidates(
  ticker: string,
  market: string | null | undefined,
  interval: "1d" | "1wk" | "1mo",
  yearsBack: number,
): Promise<Bar[]> {
  const symbols = yfSymbolCandidates(ticker, market);
  if (!symbols.length) return [];
  const primary = toYfinanceSymbol(ticker, market);
  const period1 = periodStart(yearsBack);
  let best: Bar[] = [];
  let primaryBars: Bar[] = [];

  for (const symbol of symbols) {
    try {
      const chart = await yf.chart(symbol, { period1, interval });
      const bars = mapChartBars(chart.quotes ?? []);
      const cleaned =
        interval === "1wk"
          ? normalizeWeeklyBars(bars)
          : interval === "1mo"
            ? normalizeMonthlyBars(bars)
            : bars;
      if (symbol === primary) primaryBars = cleaned;
      if (cleaned.length > best.length) best = cleaned;
    } catch {
      /* try next alias */
    }
  }

  // Prefer primary (correct board) when it has usable history.
  if (primaryBars.length >= 5) return primaryBars;
  return best;
}

export async function fetchWeeklyBars(
  ticker: string,
  market?: string | null,
  yearsBack = 2,
): Promise<Bar[]> {
  return fetchBarsWithCandidates(ticker, market, "1wk", yearsBack);
}

/** Monthly OHLC for BB NEW on 50-period band (5y history). */
export async function fetchMonthlyBars(
  ticker: string,
  market?: string | null,
  yearsBack = 5,
): Promise<Bar[]> {
  return fetchBarsWithCandidates(ticker, market, "1mo", yearsBack);
}

/** Daily OHLC for BB NEW / TQ “today / latest session” scans. */
export async function fetchDailyBars(
  ticker: string,
  market?: string | null,
  yearsBack = 1,
): Promise<Bar[]> {
  return fetchBarsWithCandidates(ticker, market, "1d", yearsBack);
}

let niftyCache: { at: number; bars: Bar[] } | null = null;
let niftyDailyCache: { at: number; bars: Bar[] } | null = null;
const NIFTY_CACHE_MS = 60 * 60 * 1000;

export async function fetchNiftyWeeklyBars(): Promise<Bar[]> {
  const now = Date.now();
  // Only reuse a successful cache — never lock in an empty Yahoo failure.
  if (
    niftyCache &&
    niftyCache.bars.length >= 65 &&
    now - niftyCache.at < NIFTY_CACHE_MS
  ) {
    return niftyCache.bars;
  }
  for (const symbol of NIFTY_SYMBOLS) {
    try {
      const chart = await yf.chart(symbol, {
        period1: periodStart(3),
        interval: "1wk",
      });
      const bars = (chart.quotes ?? [])
        .filter(
          (q) =>
            q.date &&
            q.close != null &&
            q.high != null &&
            q.low != null &&
            q.open != null,
        )
        .map((q) => ({
          date: toDateStr(new Date(q.date)),
          open: Number(q.open),
          high: Number(q.high),
          low: Number(q.low),
          close: Number(q.close),
          volume: Number(q.volume ?? 0),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const cleaned = normalizeWeeklyBars(bars);
      if (cleaned.length >= 65) {
        niftyCache = { at: now, bars: cleaned };
        return cleaned;
      }
    } catch {
      /* try next */
    }
  }
  return [];
}

export async function fetchNiftyDailyBars(): Promise<Bar[]> {
  const now = Date.now();
  if (
    niftyDailyCache &&
    niftyDailyCache.bars.length >= 65 &&
    now - niftyDailyCache.at < NIFTY_CACHE_MS
  ) {
    return niftyDailyCache.bars;
  }
  for (const symbol of NIFTY_SYMBOLS) {
    try {
      const chart = await yf.chart(symbol, {
        period1: periodStart(2),
        interval: "1d",
      });
      const bars = (chart.quotes ?? [])
        .filter(
          (q) =>
            q.date &&
            q.close != null &&
            q.high != null &&
            q.low != null &&
            q.open != null,
        )
        .map((q) => ({
          date: toDateStr(new Date(q.date)),
          open: Number(q.open),
          high: Number(q.high),
          low: Number(q.low),
          close: Number(q.close),
          volume: Number(q.volume ?? 0),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      if (bars.length >= 65) {
        niftyDailyCache = { at: now, bars };
        return bars;
      }
    } catch {
      /* try next */
    }
  }
  return [];
}

export function isSkippableSymbol(ticker: string): boolean {
  const sym = (ticker || "").trim().toUpperCase();
  if (!sym || sym.length < 2) return true;
  if (sym.includes("-RE") || sym.endsWith("-W")) return true;
  if (sym.startsWith("0P")) return true;
  return false;
}
