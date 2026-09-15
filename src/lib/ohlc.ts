import YahooFinance from "yahoo-finance2";
import fs from "fs";
import path from "path";
import type { Bar } from "./indicators";
import { toYfinanceSymbol, yfSymbolCandidates } from "./yfinance";

const yf = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  validation: { logErrors: false, logOptionsErrors: false },
});

/** Index + ETF proxies — same idea as stocks-ai (^NSEI with retries / fallbacks). */
const NIFTY_WEEKLY_SYMBOLS = [
  "^NSEI",
  "NIFTYBEES.NS",
  "^BSESN",
  "^NSEBANK",
];
const NIFTY_DAILY_SYMBOLS = ["^NSEI", "NIFTYBEES.NS", "^BSESN"];

const DATA_DIR = path.join(process.cwd(), "data");
const NIFTY_WEEKLY_DISK = path.join(DATA_DIR, "nifty-weekly-cache.json");
const NIFTY_DISK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

function periodStartDays(daysBack: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysBack);
  return toDateStr(d);
}

/** Sunday week-start for an NSE trading-week Friday (Yahoo 1wk label style). */
function weekStartSundayFromFriday(fridayIso: string): string {
  const d = new Date(`${fridayIso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 5);
  return toDateStr(d);
}

/**
 * Yahoo weekly quirks for TQ / BB:
 * - Sometimes emits both a Sunday week-start stub and a Friday tip for the
 *   same trading week (e.g. 2026-08-30 @ mid-week + 2026-09-04 @ final close).
 * - Mid-week tip with Friday still in the future must be dropped.
 *
 * Collapse to one bar per NSE trading-week Friday: earliest open, max high,
 * min low, latest close, max volume — then relabel as Sunday week-start so
 * stock/Nifty alignBars stays stable.
 */
function normalizeWeeklyBars(bars: Bar[]): Bar[] {
  if (!bars.length) return bars;
  const byFri = new Map<string, { bar: Bar; rawDate: string }>();
  for (const b of bars) {
    const fri = toTradingWeekFriday(b.date);
    const rawDate = b.date.slice(0, 10);
    const prev = byFri.get(fri);
    if (!prev) {
      byFri.set(fri, { bar: b, rawDate });
      continue;
    }
    const early = rawDate <= prev.rawDate ? b : prev.bar;
    const late = rawDate <= prev.rawDate ? prev.bar : b;
    const lateRaw = rawDate <= prev.rawDate ? prev.rawDate : rawDate;
    byFri.set(fri, {
      rawDate: lateRaw,
      bar: {
        date: early.date,
        open: early.open,
        high: Math.max(prev.bar.high, b.high),
        low: Math.min(prev.bar.low, b.low),
        close: late.close,
        volume: Math.max(prev.bar.volume || 0, b.volume || 0),
      },
    });
  }
  const today = toDateStr(new Date());
  return [...byFri.entries()]
    .filter(([fri]) => fri <= today)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([fri, { bar }]) => ({
      ...bar,
      date: weekStartSundayFromFriday(fri),
    }));
}

/**
 * Build weekly OHLC from daily (stocks-ai prepare_weekly_ohlcv idea).
 * Labels use Yahoo-style Sunday week-starts so alignBars with Nifty still matches.
 * Drops weeks whose Friday is still in the future.
 */
export function weeklyBarsFromDaily(daily: Bar[]): Bar[] {
  if (daily.length < 5) return [];
  const byFri = new Map<string, Bar[]>();
  for (const b of daily) {
    const fri = toTradingWeekFriday(b.date);
    const arr = byFri.get(fri);
    if (arr) arr.push(b);
    else byFri.set(fri, [b]);
  }
  const today = toDateStr(new Date());
  const out: Bar[] = [];
  for (const fri of [...byFri.keys()].sort()) {
    if (fri > today) continue;
    const bars = byFri.get(fri)!;
    if (!bars.length) continue;
    const first = bars[0]!;
    const last = bars[bars.length - 1]!;
    let high = first.high;
    let low = first.low;
    let volume = 0;
    for (const b of bars) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume || 0;
    }
    out.push({
      date: weekStartSundayFromFriday(fri),
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
    });
  }
  return out;
}

/**
 * yahoo-finance2 sometimes freezes a Sunday tip mid-week. Prefer daily rebuild
 * for recent weeks when the daily series includes that week's Friday session;
 * otherwise keep the (possibly Friday-labeled) weekly tip from normalizeWeeklyBars.
 */
function mergeWeeklyTipFromDaily(weekly: Bar[], daily: Bar[], weeks = 3): Bar[] {
  const fromDaily = weeklyBarsFromDaily(daily);
  if (!fromDaily.length) return weekly;
  if (!weekly.length) return normalizeWeeklyBars(fromDaily);

  const replaceFrom = fromDaily.slice(-Math.max(1, weeks));
  const dailyFriDates = new Set(daily.map((b) => b.date.slice(0, 10)));

  const byDate = new Map<string, Bar>();
  for (const b of weekly) byDate.set(b.date.slice(0, 10), b);

  for (const dBar of replaceFrom) {
    const key = dBar.date.slice(0, 10);
    const fri = toTradingWeekFriday(key);
    const hasFridaySession = dailyFriDates.has(fri);
    const prev = byDate.get(key);
    if (!prev) {
      byDate.set(key, dBar);
      continue;
    }
    // Only overwrite when daily has the Friday print (complete week).
    if (hasFridaySession) byDate.set(key, dBar);
  }
  return normalizeWeeklyBars(
    [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  );
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

async function fetchGrowwDailyBars(
  ticker: string,
  market?: string | null,
  daysBack = 400,
): Promise<Bar[]> {
  const sym = ticker.trim().toUpperCase();
  if (!sym) return [];
  const m = (market || "NSE").toUpperCase();
  const exchange = m.includes("BSE") ? "BSE" : "NSE";
  const end = Date.now();
  const start = end - Math.max(30, daysBack) * 86_400_000;
  const url =
    `https://groww.in/v1/api/charting_service/v2/chart/exchange/${exchange}` +
    `/segment/CASH/${encodeURIComponent(sym)}` +
    `?startTimeInMillis=${start}&endTimeInMillis=${end}&intervalInMinutes=1440`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "application/json",
        Referer: "https://groww.in/",
        Origin: "https://groww.in",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      candles?: Array<Array<number | null>>;
    };
    const candles = body.candles ?? [];
    const bars: Bar[] = [];
    for (const row of candles) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const epoch = Number(row[0]);
      const open = Number(row[1]);
      const high = Number(row[2]);
      const low = Number(row[3]);
      const close = Number(row[4]);
      const volume = Number(row[5] ?? 0);
      if (
        !Number.isFinite(epoch) ||
        !Number.isFinite(open) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close)
      ) {
        continue;
      }
      // Groww may send seconds or millis.
      const ms = epoch > 1e12 ? epoch : epoch * 1000;
      bars.push({
        date: toDateStr(new Date(ms)),
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
      });
    }
    return bars.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

/**
 * Try NSE / SME / BSE Yahoo aliases; keep the series with the most bars.
 * Prefer the primary board when it has enough history; otherwise fall through
 * to aliases (SME often needs `.BO` when `-SM.NS` is a stub / missing).
 * Daily path: when Yahoo is thin, fall back to Groww candles (app-wide).
 */
async function fetchBarsWithCandidates(
  ticker: string,
  market: string | null | undefined,
  interval: "1d" | "1wk" | "1mo",
  yearsBack: number,
): Promise<Bar[]> {
  const symbols = yfSymbolCandidates(ticker, market);
  const primary = toYfinanceSymbol(ticker, market);
  const period1 = periodStart(yearsBack);
  const enough =
    interval === "1d" ? 60 : interval === "1wk" ? 50 : 16;

  let best: Bar[] = [];
  let primaryBars: Bar[] = [];

  const ordered = [
    primary,
    ...symbols.filter((s) => s !== primary),
  ].filter(Boolean) as string[];

  for (const symbol of ordered) {
    try {
      const chart = await yf.chart(symbol, { period1, interval });
      const bars = mapChartBars(chart.quotes ?? []);
      const cleaned =
        interval === "1wk"
          ? normalizeWeeklyBars(bars)
          : interval === "1mo"
            ? normalizeMonthlyBars(bars)
            : bars;
      if (symbol === primary) {
        primaryBars = cleaned;
        // Enough history on primary board — stop (avoid ghost alias thrash).
        if (cleaned.length >= enough) return primaryBars;
      }
      if (cleaned.length > best.length) best = cleaned;
    } catch {
      /* try next alias */
    }
  }

  let out: Bar[] =
    primaryBars.length >= enough
      ? primaryBars
      : primaryBars.length >= 5 && primaryBars.length >= best.length
        ? primaryBars
        : best.length >= primaryBars.length
          ? best
          : primaryBars;

  // App-wide: Yahoo stub / missing SME history → Groww daily candles.
  if (interval === "1d" && out.length < enough) {
    const groww = await fetchGrowwDailyBars(
      ticker,
      market,
      Math.max(120, Math.round(yearsBack * 365)),
    );
    if (groww.length > out.length) out = groww;
  }

  return out;
}

/**
 * Weekly OHLC. Prefer Yahoo 1wk; when thin/missing, rebuild from daily
 * (Yahoo + Groww fallback) so Scan / TQ / BB W work for SME stubs.
 */
export async function fetchWeeklyBars(
  ticker: string,
  market?: string | null,
  yearsBack = 2,
): Promise<Bar[]> {
  const weeklyEnough = 50;
  let weekly = await fetchBarsWithCandidates(ticker, market, "1wk", yearsBack);

  // Always pull daily (Groww-backed) so we can rebuild or fix the tip week.
  let daily: Bar[] = [];
  try {
    daily = await fetchDailyBars(ticker, market, yearsBack);
  } catch {
    daily = [];
  }

  if (weekly.length < weeklyEnough) {
    const fromDaily = weeklyBarsFromDaily(daily);
    if (fromDaily.length > weekly.length) weekly = fromDaily;
  } else if (daily.length >= 10) {
    weekly = mergeWeeklyTipFromDaily(weekly, daily, 3);
  }

  return weekly;
}

/** Recent daily bars (tip-week refresh / short lookbacks). */
async function fetchRecentDailyBars(
  ticker: string,
  market: string | null | undefined,
  daysBack: number,
): Promise<Bar[]> {
  // Reuse the app-wide daily path (Yahoo aliases + Groww when thin).
  const years = Math.max(1, Math.ceil(daysBack / 365));
  const bars = await fetchDailyBars(ticker, market, years);
  if (bars.length <= daysBack + 5) return bars;
  const cut = periodStartDays(daysBack);
  return bars.filter((b) => b.date.slice(0, 10) >= cut);
}

/**
 * Monthly OHLC. Prefer Yahoo 1mo; when thin/missing, rebuild from daily
 * (Yahoo + Groww) so BB M / RSI paths work for SME stubs.
 */
export async function fetchMonthlyBars(
  ticker: string,
  market?: string | null,
  yearsBack = 5,
): Promise<Bar[]> {
  const monthlyEnough = 16;
  let monthly = await fetchBarsWithCandidates(ticker, market, "1mo", yearsBack);
  if (monthly.length >= monthlyEnough) return monthly;

  const daily = await fetchDailyBars(ticker, market, yearsBack);
  const built = monthlyBarsFromDaily(daily);
  if (built.length > monthly.length) return built;
  return monthly.length ? monthly : built;
}

/**
 * Build month-end OHLC from daily bars when Yahoo `1mo` is a stub (common on SME).
 */
export function monthlyBarsFromDaily(daily: Bar[]): Bar[] {
  if (daily.length < 20) return [];
  const byMonth = new Map<string, Bar[]>();
  for (const b of daily) {
    const key = b.date.slice(0, 7);
    const arr = byMonth.get(key);
    if (arr) arr.push(b);
    else byMonth.set(key, [b]);
  }
  const months = [...byMonth.keys()].sort();
  const out: Bar[] = [];
  for (const key of months) {
    const bars = byMonth.get(key)!;
    if (!bars.length) continue;
    const first = bars[0]!;
    const last = bars[bars.length - 1]!;
    let high = first.high;
    let low = first.low;
    let volume = 0;
    for (const b of bars) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume || 0;
    }
    out.push({
      date: last.date.slice(0, 10),
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
    });
  }
  return normalizeMonthlyBars(out);
}

/** Monthly bars with daily fallback only when Yahoo monthly is a short stub. */
export async function fetchMonthlyBarsForRsi(
  ticker: string,
  market?: string | null,
  yearsBack = 5,
  minBars = 16,
): Promise<Bar[]> {
  // fetchMonthlyBars already rebuilds from Groww-backed daily when thin.
  const monthly = await fetchMonthlyBars(ticker, market, yearsBack);
  if (monthly.length >= minBars) return monthly;
  if (monthly.length === 0) {
    const daily = await fetchDailyBars(ticker, market, Math.min(yearsBack, 3));
    return monthlyBarsFromDaily(daily);
  }
  const daily = await fetchDailyBars(ticker, market, Math.min(yearsBack, 3));
  const built = monthlyBarsFromDaily(daily);
  return built.length >= monthly.length ? built : monthly;
}

/** Daily OHLC — Yahoo board aliases, then Groww when history is thin (app-wide). */
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
const NIFTY_MIN_WEEKLY = 52;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function chartQuotesToBars(
  quotes: Array<{
    date?: Date;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    close?: number | null;
    volume?: number | null;
  }>,
): Bar[] {
  return (quotes ?? [])
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

function readNiftyWeeklyDisk(): Bar[] | null {
  try {
    if (!fs.existsSync(NIFTY_WEEKLY_DISK)) return null;
    const raw = JSON.parse(fs.readFileSync(NIFTY_WEEKLY_DISK, "utf8")) as {
      at?: number;
      bars?: Bar[];
    };
    if (!raw?.bars?.length || !raw.at) return null;
    if (Date.now() - raw.at > NIFTY_DISK_MAX_AGE_MS) return null;
    if (raw.bars.length < NIFTY_MIN_WEEKLY) return null;
    return raw.bars;
  } catch {
    return null;
  }
}

function writeNiftyWeeklyDisk(bars: Bar[]): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      NIFTY_WEEKLY_DISK,
      JSON.stringify({ at: Date.now(), bars }),
      "utf8",
    );
  } catch {
    /* ignore disk cache write */
  }
}

async function fetchIndexWeeklyOnce(
  symbol: string,
  yearsBack: number,
): Promise<Bar[]> {
  const chart = await yf.chart(symbol, {
    period1: periodStart(yearsBack),
    interval: "1wk",
  });
  let weekly = normalizeWeeklyBars(chartQuotesToBars(chart.quotes ?? []));
  try {
    const dailyChart = await yf.chart(symbol, {
      period1: periodStartDays(120),
      interval: "1d",
    });
    const daily = chartQuotesToBars(dailyChart.quotes ?? []);
    if (daily.length >= 10) {
      weekly = mergeWeeklyTipFromDaily(weekly, daily, 3);
    }
  } catch {
    /* keep weekly */
  }
  return weekly;
}

/**
 * Nifty weekly for TQ RS — stocks-ai style: retries, shorter periods,
 * ETF proxy, then last-good disk cache so a Yahoo blip doesn't kill TQ.
 */
export async function fetchNiftyWeeklyBars(): Promise<Bar[]> {
  const now = Date.now();
  if (
    niftyCache &&
    niftyCache.bars.length >= NIFTY_MIN_WEEKLY &&
    now - niftyCache.at < NIFTY_CACHE_MS
  ) {
    return niftyCache.bars;
  }

  const yearOpts = [3, 2, 1];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const yearsBack of yearOpts) {
      for (const symbol of NIFTY_WEEKLY_SYMBOLS) {
        try {
          const cleaned = await fetchIndexWeeklyOnce(symbol, yearsBack);
          if (cleaned.length >= NIFTY_MIN_WEEKLY) {
            niftyCache = { at: now, bars: cleaned };
            writeNiftyWeeklyDisk(cleaned);
            return cleaned;
          }
        } catch {
          /* try next symbol / period */
        }
      }
    }
    await sleep(400 + attempt * 600);
  }

  const disk = readNiftyWeeklyDisk();
  if (disk) {
    niftyCache = { at: now, bars: disk };
    return disk;
  }
  return [];
}

export async function fetchNiftyDailyBars(): Promise<Bar[]> {
  const now = Date.now();
  if (
    niftyDailyCache &&
    niftyDailyCache.bars.length >= 40 &&
    now - niftyDailyCache.at < NIFTY_CACHE_MS
  ) {
    return niftyDailyCache.bars;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const yearsBack of [2, 1]) {
      for (const symbol of NIFTY_DAILY_SYMBOLS) {
        try {
          const chart = await yf.chart(symbol, {
            period1: periodStart(yearsBack),
            interval: "1d",
          });
          const bars = chartQuotesToBars(chart.quotes ?? []);
          if (bars.length >= 40) {
            niftyDailyCache = { at: now, bars };
            return bars;
          }
        } catch {
          /* try next */
        }
      }
    }
    await sleep(300 + attempt * 400);
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
