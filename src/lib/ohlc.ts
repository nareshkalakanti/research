import YahooFinance from "yahoo-finance2";
import type { Bar } from "./indicators";
import { toYfinanceSymbol } from "./yfinance";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const NIFTY_SYMBOLS = ["^NSEI", "^NSEBANK"]; // fallback unused for now — ^NSEI first

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function periodStart(yearsBack: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - yearsBack);
  return toDateStr(d);
}

/** Drop Yahoo's in-progress week (gap from prior weekly bar < 6 days). */
function dropIncompleteWeek(bars: Bar[]): Bar[] {
  if (bars.length < 2) return bars;
  const last = Date.parse(`${bars[bars.length - 1].date}T00:00:00Z`);
  const prev = Date.parse(`${bars[bars.length - 2].date}T00:00:00Z`);
  if (!Number.isFinite(last) || !Number.isFinite(prev)) return bars;
  const gapDays = (last - prev) / 86_400_000;
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
    return dropIncompleteWeek(bars);
  } catch {
    return [];
  }
}

let niftyCache: { at: number; bars: Bar[] } | null = null;
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
      const cleaned = dropIncompleteWeek(bars);
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

export function isSkippableSymbol(ticker: string): boolean {
  const sym = (ticker || "").trim().toUpperCase();
  if (!sym || sym.length < 2) return true;
  if (sym.includes("-RE") || sym.endsWith("-W")) return true;
  if (sym.startsWith("0P")) return true;
  return false;
}
