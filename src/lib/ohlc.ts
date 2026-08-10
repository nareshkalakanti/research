import YahooFinance from "yahoo-finance2";
import type { Bar } from "./indicators";
import { toYfinanceSymbol } from "./yfinance";

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
 */
function normalizeWeeklyBars(bars: Bar[]): Bar[] {
  if (bars.length < 2) return bars;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (last.date.slice(0, 10) === prev.date.slice(0, 10)) {
    return bars.slice(0, -1);
  }
  const lastTs = Date.parse(`${last.date}T00:00:00Z`);
  const prevTs = Date.parse(`${prev.date}T00:00:00Z`);
  if (!Number.isFinite(lastTs) || !Number.isFinite(prevTs)) return bars;
  const gapDays = (lastTs - prevTs) / 86_400_000;
  if (gapDays < 6) return bars.slice(0, -1);
  return bars;
}

export async function fetchWeeklyBars(
  ticker: string,
  market?: string | null,
  yearsBack = 2,
): Promise<Bar[]> {
  const symbol = toYfinanceSymbol(ticker, market);
  if (!symbol) return [];
  try {
    const chart = await yf.chart(symbol, {
      period1: periodStart(yearsBack),
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
    return normalizeWeeklyBars(bars);
  } catch {
    return [];
  }
}

/** Daily OHLC for BB NEW / TQ “today / latest session” scans. */
export async function fetchDailyBars(
  ticker: string,
  market?: string | null,
  yearsBack = 1,
): Promise<Bar[]> {
  const symbol = toYfinanceSymbol(ticker, market);
  if (!symbol) return [];
  try {
    const chart = await yf.chart(symbol, {
      period1: periodStart(yearsBack),
      interval: "1d",
    });
    return (chart.quotes ?? [])
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
  } catch {
    return [];
  }
}

let niftyCache: { at: number; bars: Bar[] } | null = null;
let niftyDailyCache: { at: number; bars: Bar[] } | null = null;
const NIFTY_CACHE_MS = 60 * 60 * 1000;

export async function fetchNiftyWeeklyBars(): Promise<Bar[]> {
  const now = Date.now();
  if (niftyCache && now - niftyCache.at < NIFTY_CACHE_MS) {
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
  niftyCache = { at: now, bars: [] };
  return [];
}

export async function fetchNiftyDailyBars(): Promise<Bar[]> {
  const now = Date.now();
  if (niftyDailyCache && now - niftyDailyCache.at < NIFTY_CACHE_MS) {
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
  niftyDailyCache = { at: now, bars: [] };
  return [];
}

export function isSkippableSymbol(ticker: string): boolean {
  const sym = (ticker || "").trim().toUpperCase();
  if (!sym || sym.length < 2) return true;
  if (sym.includes("-RE") || sym.endsWith("-W")) return true;
  if (sym.startsWith("0P")) return true;
  return false;
}
