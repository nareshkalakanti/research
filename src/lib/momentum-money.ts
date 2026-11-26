import { isRightsOrPartlyPaid } from "./listing-name-match";
import { weekKey } from "./lockout";
import { earlyGrowth, quartersFor } from "./ipo-growth";
import { analyzeBases, IPO2_BEST, IPO2_RULES, type Verdict } from "./ipo2-bases";
import { loadMetricsMap } from "./metrics";
import { fetchDailyBars, fetchNiftyDailyBars } from "./ohlc";
import { runConcurrent } from "./scrape-pool";
import { cachedRotationCloses, type Close } from "./rotation-bars";
import { listRotationSectors, type SectorMember } from "./sector-rotation";
import { rotationFetchYears } from "./sector-rotation-series";
import { openSqliteNamed } from "./sqlite-utils";
import { masterLabels } from "./stock-master";

/**
 * Momentum and Money: yearly winners (200%+ from the 52-week low) and, for each, the
 * measures from the user's "Winners" study — stage 4 decline, lockout rally, bases —
 * read from saved daily closes (rotation_bars.db; no fetching).
 *
 * Definitions (closes only; a week = Mon–Sun, its last close):
 *   Gains from 52wk low   best day of the year: close ÷ lowest close of the 52 weeks before it − 1
 *   YoY change            that day's close ÷ the close a year earlier − 1
 *   Lockout rally         after the 52-week low, the first 8-week stretch with 6+ green weeks whose run makes a 50%+
 *                         up move (notes: "6/8 green weeks, min 50% up move"); starts at the lowest weekly close
 *                         before the stretch, ends at the high before the first 2-week pause once it is 50%+ up
 *                         (notes: "take a pause of 2 weeks (not hit above its previous swing high)")
 *   Stage 4 decline       within the 2 years before the rally: highest close → the lowest close after it
 *   Base 1 / Base 2       pause of 2+ weeks from a high until a week trades above it: depth (high → lowest low) / weeks
 */
export const MM_RULES = {
  lockoutWeeks: 8,
  lockoutGreen: 6,
  urgency12: 9,
  minUpPct: 50,
  /** A pause this long (no week above the swing high) is a base and ends the rally ("take a pause of 2 weeks"). */
  baseWeeks: 2,
  priorHighWeeks: 104,
  bigWeekPct: 20,
  ipoYears: 3,
} as const;

/** Daily bar: closes only, or a full candle (open / high / low) when fetched. */
export type Candle = { date: string; close: number; open?: number; high?: number; low?: number };
/** Weekly bar. Closes-only: high = low = the week's close. Candles: the week's high / low, and its open. */
type Week = { open: number; high: number; low: number; close: number; first: number; last: number };

export type MmBase = { depth_pct: number; weeks: number; open: boolean; nifty_pct: number | null; start: string; end: string | null };

export type MmStudy = {
  /** Read from daily candles (highs / lows) rather than closes. */
  candles: boolean;
  rally_from: string;
  rally_to: string;
  rally_weeks: number;
  rally_pct: number;
  green8: number;
  green12: number | null;
  big_weeks: number;
  first_big_week: string | null;
  /** Every 20%+ week inside the rally (week's last date). */
  big_week_dates: string[];
  /** Stage 4: the prior high and the low after it (null when no decline). */
  stage4_high_date: string | null;
  stage4_low_date: string | null;
  stage4_pct: number | null;
  /** Nifty's fall over the same dates, %. */
  stage4_nifty_pct: number | null;
  /** Stock decline ÷ Nifty decline. */
  stage4_x: number | null;
  /** Fewer than 2 years of saved prices before the rally. */
  short_history: boolean;
  base1: MmBase | null;
  base2: MmBase | null;
};

export type MmRow = {
  ticker: string;
  name: string;
  market: string;
  listing_date: string | null;
  yoy_pct: number | null;
  gain_pct: number;
  industry: string | null;
  mcap_cr: number | null;
  /** Listed within 3 years before the rally started. */
  ipo: boolean;
  /** Best day of the year and the 52-week low before it (what the gain is measured between). */
  best_date: string;
  low_date: string;
  study: MmStudy | null;
};

export type MmResult = {
  year: number;
  years: number[];
  as_of: string | null;
  rows: MmRow[];
  universe: number;
  nifty: boolean;
  rules: typeof MM_RULES;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

function weekly(s: Candle[], candles: boolean): Week[] {
  const out: Week[] = [];
  let wk = "";
  for (let i = 0; i < s.length; i++) {
    const b = s[i]!;
    const hi = candles ? (b.high ?? b.close) : b.close;
    const lo = candles ? (b.low ?? b.close) : b.close;
    const k = weekKey(b.date);
    if (k !== wk) {
      out.push({ open: candles ? (b.open ?? b.close) : b.close, high: hi, low: lo, close: b.close, first: i, last: i });
      wk = k;
    } else {
      const w = out[out.length - 1]!;
      w.close = b.close;
      w.last = i;
      if (candles) {
        w.high = Math.max(w.high, hi);
        w.low = Math.min(w.low, lo);
      } else w.high = w.low = b.close;
    }
  }
  return out;
}

/** Index of the last bar on or before an ISO date (−1 when none). */
function idxOnOrBefore(s: { date: string }[], iso: string): number {
  let lo = 0;
  let hi = s.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid]!.date <= iso) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function isoMinusDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Nifty fall between two dates: highest close in the span → close at the end, %. */
function niftyFall(nifty: Close[] | null, from: string, to: string): number | null {
  if (!nifty?.length) return null;
  const a = idxOnOrBefore(nifty, from);
  const b = idxOnOrBefore(nifty, to);
  if (a < 0 || b < a || nifty[0]!.date > from) return null;
  let hi = 0;
  for (let i = a; i <= b; i++) hi = Math.max(hi, nifty[i]!.close);
  return hi > 0 ? r1((1 - nifty[b]!.close / hi) * 100) : null;
}

/** Pause from week h (a high) until a week that trades above it ("hits above its previous swing high"). */
function baseFrom(s: Candle[], w: Week[], h: number, nifty: Close[] | null): { base: MmBase; breakout: number | null } {
  const H = w[h]!.high;
  let low = Infinity;
  let k = h + 1;
  for (; k < w.length; k++) {
    if (w[k]!.high > H) break;
    low = Math.min(low, w[k]!.low);
  }
  const open = k >= w.length;
  const endW = open ? w.length - 1 : k;
  const start = s[w[h]!.last]!.date;
  const end = open ? null : s[w[k]!.last]!.date;
  const nf = niftyFall(nifty, start, s[w[open ? w.length - 1 : k - 1]!.last]!.date);
  return {
    base: {
      depth_pct: Number.isFinite(low) ? r1((1 - low / H) * 100) : 0,
      weeks: endW - h,
      open,
      nifty_pct: nf,
      start,
      end,
    },
    breakout: open ? null : k,
  };
}

/**
 * The winner's lockout rally, the stage 4 decline before it, and the two bases after it.
 * `lowDate` is the 52-week low the year's gain is measured from. With candles (high / low / open)
 * green weeks are green candles and depths run high → low; with closes only, everything uses closes.
 */
export function studyWinner(s: Candle[], lowDate: string, nifty: Close[] | null, R = MM_RULES): MmStudy | null {
  const candles = s.some((b) => b.high != null && b.low != null);
  const w = weekly(s, candles);
  const lowIdx = idxOnOrBefore(s, lowDate);
  const lowW = w.findIndex((x) => x.first <= lowIdx && lowIdx <= x.last);
  if (lowW < 0) return null;
  const isGreen = (k: number) => (candles ? w[k]!.close > w[k]!.open : k > 0 && w[k]!.close > w[k - 1]!.close);
  // Runs after the low: an 8-week stretch with 6+ green weeks, carried to the first 4+ week pause (no week
  // above the swing high); the first such run that makes a 50%+ move is the lockout rally.
  // A pause only ends the lockout rally once it has made its 50% move ("min 50% up move"); a close
  // under the starting low ends a run that never got there.
  const runEnd = (from: number, needPct = 0) => {
    let h = from;
    for (let k = from + 1; k < w.length; k++) {
      if (w[k]!.high > w[h]!.high) h = k;
      else if (k - h >= R.baseWeeks && (w[h]!.high / w[from]!.low - 1) * 100 >= needPct) break;
      if (w[k]!.close < w[from]!.low) break;
    }
    return h;
  };
  let searchFrom = lowW;
  let s0 = -1;
  let hW = -1;
  /** First week of the 8-week stretch that qualified the run. */
  let stretch = -1;
  for (let a = lowW + 1; a + R.lockoutWeeks - 1 < w.length; a++) {
    let g = 0;
    for (let k = a; k < a + R.lockoutWeeks; k++) if (isGreen(k)) g++;
    if (g < R.lockoutGreen) continue;
    let st = searchFrom;
    for (let k = searchFrom; k < a; k++) if (w[k]!.low < w[st]!.low) st = k;
    const end = runEnd(st, R.minUpPct);
    if ((w[end]!.high / w[st]!.low - 1) * 100 >= R.minUpPct) {
      s0 = st;
      hW = end;
      stretch = a;
      break;
    }
    // Too small: look again after this run.
    searchFrom = Math.max(end, a);
    a = searchFrom;
  }
  if (s0 < 0) return null;
  const green = (from: number, len: number) => {
    let g = 0;
    for (let k = from; k < Math.min(w.length, from + len); k++) if (isGreen(k)) g++;
    return g;
  };
  let big = 0;
  let firstBig: string | null = null;
  const bigDates: string[] = [];
  for (let k = s0 + 1; k <= hW; k++)
    if ((w[k]!.close / w[k - 1]!.close - 1) * 100 >= R.bigWeekPct) {
      big++;
      firstBig ??= s[w[k]!.last]!.date;
      bigDates.push(s[w[k]!.last]!.date);
    }
  // Stage 4: within the 2 years before the start, the highest high and the lowest low after it.
  const from = Math.max(0, s0 - R.priorHighWeeks);
  let ph = from;
  for (let k = from; k <= s0; k++) if (w[k]!.high > w[ph]!.high) ph = k;
  let pl = ph;
  for (let k = ph; k <= s0; k++) if (w[k]!.low < w[pl]!.low) pl = k;
  const decline = pl > ph ? (1 - w[pl]!.low / w[ph]!.high) * 100 : 0;
  const nf = pl > ph ? niftyFall(nifty, s[w[ph]!.last]!.date, s[w[pl]!.last]!.date) : null;
  const b1 = hW < w.length - 1 ? baseFrom(s, w, hW, nifty) : null;
  let b2: MmBase | null = null;
  if (b1?.breakout != null) {
    // Next 2-week pause after the base 1 breakout.
    const h = runEnd(b1.breakout);
    if (h < w.length - 1) b2 = baseFrom(s, w, h, nifty).base;
  }
  return {
    candles,
    rally_from: s[w[s0]!.last]!.date,
    rally_to: s[w[hW]!.last]!.date,
    rally_weeks: hW - s0,
    rally_pct: r1((w[hW]!.high / w[s0]!.low - 1) * 100),
    // Counted over the stretch that qualified the rally (and the 12 weeks from it).
    green8: green(stretch, R.lockoutWeeks),
    green12: stretch + 11 < w.length ? green(stretch, 12) : null,
    big_weeks: big,
    first_big_week: firstBig,
    big_week_dates: bigDates,
    stage4_high_date: pl > ph ? s[w[ph]!.last]!.date : null,
    stage4_low_date: pl > ph ? s[w[pl]!.last]!.date : null,
    stage4_pct: r1(decline),
    stage4_nifty_pct: nf,
    stage4_x: nf != null && nf >= 3 ? r1(decline / nf) : null,
    short_history: s0 - R.priorHighWeeks < 0,
    base1: b1?.base ?? null,
    base2: b2,
  };
}

function uniqueMembers(): SectorMember[] {
  const seen = new Map<string, SectorMember>();
  for (const sec of listRotationSectors())
    for (const m of sec.members) {
      const t = m.ticker.toUpperCase();
      if (seen.has(t) || isRightsOrPartlyPaid(m.ticker, m.name)) continue;
      seen.set(t, m);
    }
  return [...seen.values()];
}

/** NSE listing dates saved earlier in strategy.db (read only); empty when missing. */
function listingDates(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const db = openSqliteNamed("strategy.db", { readonly: true });
    try {
      const rows = db.prepare("SELECT ticker, listing_date FROM ipo_listing_dates").all() as Array<{ ticker: string; listing_date: string }>;
      for (const r of rows) out.set(r.ticker.toUpperCase(), r.listing_date);
    } finally {
      db.close();
    }
  } catch {
    /* no saved listing dates */
  }
  return out;
}

async function niftyCloses(years: number): Promise<Close[] | null> {
  try {
    const bars = await fetchNiftyDailyBars(years);
    return bars.length ? bars.map((b) => ({ date: b.date, close: b.close })) : null;
  } catch {
    return null;
  }
}

const cache = new Map<number, { at: number; result: MmResult }>();
const CACHE_MS = 10 * 60_000;

/** All stocks with saved prices: winners of `year` (gain from the 52-week low ≥ 100% kept; the page filters). */
export async function buildMomentumMoney(year?: number): Promise<MmResult> {
  const nowYear = new Date().getUTCFullYear();
  const y = year && year >= 2000 && year <= nowYear ? year : nowYear - 1;
  const hit = cache.get(y);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const members = uniqueMembers();
  const yearsBack = rotationFetchYears();
  const nifty = await niftyCloses(yearsBack + 1);
  const metrics = loadMetricsMap();
  const labels = masterLabels();
  const listed = listingDates();
  const yearEnd = `${y}-12-31`;
  let asOf: string | null = null;
  let firstYear = nowYear;

  const rows: MmRow[] = [];
  for (const m of members) {
    const s = cachedRotationCloses(m.ticker, m.market, yearsBack);
    if (s.length < 60) continue;
    firstYear = Math.min(firstYear, Number(s[0]!.date.slice(0, 4)));
    const end = idxOnOrBefore(s, yearEnd);
    if (end < 0 || s[end]!.date < `${y}-01-01`) continue;
    if (!asOf || s[end]!.date > asOf) asOf = s[end]!.date;
    const start = idxOnOrBefore(s, `${y - 1}-12-31`) + 1;
    // Best day of the year: close vs the lowest close of the 52 weeks before it (sliding minimum).
    let best = -1;
    let bestGain = -Infinity;
    let bestLow = -1;
    const dq: number[] = [];
    let from = 0;
    for (let i = 0; i <= end; i++) {
      while (dq.length && s[dq[dq.length - 1]!]!.close >= s[i]!.close) dq.pop();
      dq.push(i);
      const cut = isoMinusDays(s[i]!.date, 365);
      while (s[from]!.date <= cut) from++;
      while (dq[0]! < from) dq.shift();
      if (i < start) continue;
      const g = s[i]!.close / s[dq[0]!]!.close - 1;
      if (g > bestGain) {
        bestGain = g;
        best = i;
        bestLow = dq[0]!;
      }
    }
    if (best < 0) continue;
    const gain = bestGain * 100;
    if (gain < 100) continue;
    const lowIdx = bestLow;
    const yearAgo = idxOnOrBefore(s, isoMinusDays(s[best]!.date, 365));
    const t = m.ticker.toUpperCase();
    const lab = labels.get(t);
    const study = studyWinner(s, s[lowIdx]!.date, nifty);
    const ld = listed.get(t) ?? null;
    const ipo =
      ld != null && study != null && Date.parse(study.rally_from) - Date.parse(ld) <= MM_RULES.ipoYears * 365.25 * 86_400_000;
    rows.push({
      ticker: t,
      name: m.name,
      market: m.market || "NSE",
      listing_date: ld,
      yoy_pct: yearAgo >= 0 && Date.parse(s[best]!.date) - Date.parse(s[yearAgo]!.date) >= 350 * 86_400_000 ? r1((s[best]!.close / s[yearAgo]!.close - 1) * 100) : null,
      gain_pct: r1(gain),
      industry: lab?.industry ?? lab?.sector ?? null,
      mcap_cr: metrics.get(t)?.market_cap_cr ?? null,
      ipo,
      best_date: s[best]!.date,
      low_date: s[lowIdx]!.date,
      study,
    });
  }
  rows.sort((a, b) => b.gain_pct - a.gain_pct);
  const years: number[] = [];
  for (let k = nowYear; k >= Math.max(firstYear, nowYear - 6); k--) years.push(k);
  const result: MmResult = { year: y, years, as_of: asOf, rows, universe: members.length, nifty: nifty != null, rules: MM_RULES };
  cache.set(y, { at: Date.now(), result });
  return result;
}

/* ------------------------------------------------------------------ */
/* Daily candles for winners (Yahoo, saved in winners_ohlc.db)         */
/* ------------------------------------------------------------------ */

const OHLC_TTL_MS = 24 * 3_600_000;

function ohlcDb() {
  const db = openSqliteNamed("winners_ohlc.db", { readonly: false, wal: true });
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS ohlc (
    ticker TEXT NOT NULL,
    market TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    bars TEXT NOT NULL,
    PRIMARY KEY (ticker, market)
  )`);
  return db;
}

/** Saved daily candles when fresh, else fetched from Yahoo and saved. Null when Yahoo has nothing. */
async function winnerCandles(ticker: string, market: string): Promise<Candle[] | null> {
  const t = ticker.toUpperCase();
  const db = ohlcDb();
  try {
    const row = db.prepare("SELECT fetched_at, bars FROM ohlc WHERE ticker = ? AND market = ?").get(t, market) as
      | { fetched_at: number; bars: string }
      | undefined;
    if (row && Date.now() - row.fetched_at < OHLC_TTL_MS) return unpack(row.bars);
    let bars: Candle[] = [];
    try {
      bars = (await fetchDailyBars(t, market, rotationFetchYears() + 1)).map((b) => ({
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }));
    } catch {
      bars = [];
    }
    if (bars.length < 60) return row ? unpack(row.bars) : null;
    db.prepare("INSERT OR REPLACE INTO ohlc (ticker, market, fetched_at, bars) VALUES (?, ?, ?, ?)").run(
      t,
      market,
      Date.now(),
      JSON.stringify(bars.map((b) => [b.date, b.open, b.high, b.low, b.close])),
    );
    return bars;
  } finally {
    db.close();
  }
}

function unpack(json: string): Candle[] {
  return (JSON.parse(json) as Array<[string, number, number, number, number]>).map(([date, open, high, low, close]) => ({
    date,
    open,
    high,
    low,
    close,
  }));
}

/** Studies from daily candles for these winners of `year` (null where Yahoo has no candles). */
export async function candleStudies(year: number, tickers: string[]): Promise<Record<string, MmStudy | null>> {
  const r = await buildMomentumMoney(year);
  const want = new Set(tickers.map((t) => t.toUpperCase()));
  const rows = r.rows.filter((x) => want.has(x.ticker)).slice(0, 400);
  const nifty = await niftyCloses(rotationFetchYears() + 1);
  const out: Record<string, MmStudy | null> = {};
  await runConcurrent(rows, 4, async (row) => {
    const bars = await winnerCandles(row.ticker, row.market);
    // The 52-week low on candles: lowest low in the year before the best day.
    let lowDate = row.low_date;
    if (bars?.length) {
      const from = isoMinusDays(row.best_date, 365);
      let lo = Infinity;
      for (const b of bars) if (b.date > from && b.date <= row.best_date && (b.low ?? b.close) < lo) {
        lo = b.low ?? b.close;
        lowDate = b.date;
      }
    }
    out[row.ticker] = bars ? studyWinner(bars, lowDate, nifty) : null;
  });
  return out;
}

export type MmChartWeek = { date: string; open: number; high: number; low: number; close: number };

/** Old IPO2 entries kept for the chart's IPO2 tab: the three that worked best across all stocks (2023–25). */
export type MmIpo2Entry = { kind: "ipo_range" | "pivot" | "add"; label: string; date: string; level: number; stop: number; risk_pct: number };
const IPO2_KEEP = IPO2_BEST;

export type MmChart =
  | {
      ok: true;
      ticker: string;
      candles: boolean;
      weeks: MmChartWeek[];
      /** The last ~12 months of daily bars (for the 1Y view). */
      days: MmChartWeek[];
      study: MmStudy | null;
      /** IPO rules applied (listed in the last 4 years) for the IPO2 entries. */
      ipo2_listed: boolean;
      ipo2: MmIpo2Entry[];
      /** Today's call from the IPO2 rules (kept entries only, no sells). */
      verdict: Verdict | null;
      /** The momentum notes checked on this stock's study (winner year, or the trailing year). */
      momentum: Array<{ good: boolean; text: string }>;
      stage_note: string | null;
      listing_date: string | null;
      issue_price: number | null;
      listing_gain_pct: number | null;
    }
  | { ok: false; error: string };

/** Issue prices saved earlier in strategy.db (read only). */
function issuePrice(ticker: string, listing: string): number | null {
  try {
    const db = openSqliteNamed("strategy.db", { readonly: true });
    try {
      const r = db.prepare("SELECT issue_price, listing_date FROM ipo_issue_prices WHERE symbol = ?").get(ticker.toUpperCase()) as
        | { issue_price: number; listing_date: string }
        | undefined;
      // Same listing (within 10 days), else it's another issue (e.g. an SME migration).
      return r && Math.abs(Date.parse(r.listing_date) - Date.parse(listing)) <= 10 * 86_400_000 ? r.issue_price : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Old IPO2 analysis from saved daily closes: kept entries only, verdict without sells. */
function ipo2Analysis(ticker: string, market: string, nifty: Close[] | null) {
  let s = cachedRotationCloses(ticker, market, rotationFetchYears());
  if (s.length < 30) return null;
  const ld = listingDates().get(ticker.toUpperCase()) ?? null;
  const isNew = !!ld && ld >= s[0]!.date && Date.parse(s[s.length - 1]!.date) - Date.parse(ld) < 4 * 365.25 * 86_400_000;
  if (isNew) s = s.filter((b) => b.date >= ld!);
  const a = analyzeBases(s, {
    listed: isNew,
    issuePrice: isNew ? issuePrice(ticker, ld!) : null,
    market: isNew ? nifty : null,
    keep: IPO2_KEEP,
    sells: false,
  });
  if (!a) return null;
  return {
    listed: isNew,
    listing_date: isNew ? ld : null,
    issue_price: a.issue_mismatch ? null : a.issue_price,
    listing_gain_pct: a.listing_gain_pct,
    verdict: a.verdict,
    stage_note: a.stage_note,
    entries: a.entries.map((e) => ({
      kind: e.kind as MmIpo2Entry["kind"],
      label: e.label,
      date: e.date,
      level: e.level,
      stop: e.stop,
      risk_pct: e.risk_pct,
    })),
  };
}

/** The momentum notes as verdict lines (good / caution), from the study. */
function momentumReasons(st: MmStudy): Array<{ good: boolean; text: string }> {
  const out: Array<{ good: boolean; text: string }> = [];
  out.push({
    good: st.green8 >= 6,
    text: `Lockout rally +${Math.round(st.rally_pct)}% in ${st.rally_weeks} weeks (${shortDay(st.rally_from)} – ${shortDay(st.rally_to)}), ${st.green8}/8 green weeks${
      st.green12 != null ? `, ${st.green12}/12` : ""
    }`,
  });
  if (st.big_weeks) out.push({ good: true, text: `Posted a 20% week inside the lockout rally (${st.big_weeks}×)` });
  if (st.stage4_pct)
    out.push({
      good: st.stage4_pct >= 40 && st.stage4_pct <= 50,
      text: `Stage 4 decline ${Math.round(st.stage4_pct)}% (notes: 40–50%)${st.stage4_x != null ? `, ${st.stage4_x}x Nifty's fall (notes: 2–2.5x)` : ""}`,
    });
  for (const [b, name] of [
    [st.base1, "Base 1"],
    [st.base2, "Base 2"],
  ] as const)
    if (b)
      out.push({
        good: b.depth_pct >= 15 && b.depth_pct <= 25,
        text: `${name} ${Math.round(b.depth_pct)}% deep, ${b.weeks} weeks${b.open ? " so far" : ""} (notes: 15–25%, 4–12 weeks)`,
      });
  return out;
}

function shortDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });
}

/**
 * One stock's weekly bars (candles when Yahoo has them), its momentum study and the old IPO2 entries.
 * With a year: the study is that year's winner study. Without (Napkin): the trailing year's — the best
 * close of the last 365 days against the lowest low of the year before it.
 */
export async function stockChart(ticker: string, opts: { year?: number; market?: string | null }): Promise<MmChart> {
  const t = ticker.toUpperCase();
  let market = (opts.market || "").trim();
  let bestDate: string | null = null;
  if (opts.year) {
    const r = await buildMomentumMoney(opts.year);
    const row = r.rows.find((x) => x.ticker === t);
    if (!row) return { ok: false, error: `${t} is not a ${opts.year} winner` };
    market = row.market;
    bestDate = row.best_date;
  }
  if (!market) market = uniqueMembers().find((m) => m.ticker.toUpperCase() === t)?.market || "NSE";
  const fetched = await winnerCandles(t, market);
  const bars: Candle[] = fetched ?? cachedRotationCloses(t, market, rotationFetchYears());
  if (bars.length < 60) return { ok: false, error: `No prices for ${t}` };
  const lowOf = (b: Candle) => b.low ?? b.close;
  if (!bestDate) {
    // Trailing year: the day with the biggest gain from the lowest low of the 365 days before it.
    const startIso = isoMinusDays(bars[bars.length - 1]!.date, 365);
    let best = -Infinity;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i]!.date < startIso) continue;
      const from = isoMinusDays(bars[i]!.date, 365);
      let lo = Infinity;
      for (let j = i; j >= 0 && bars[j]!.date > from; j--) lo = Math.min(lo, lowOf(bars[j]!));
      const g = bars[i]!.close / lo;
      if (g > best) {
        best = g;
        bestDate = bars[i]!.date;
      }
    }
  }
  const from = isoMinusDays(bestDate!, 365);
  let lo = Infinity;
  let lowDate = bestDate!;
  for (const b of bars)
    if (b.date > from && b.date <= bestDate! && lowOf(b) < lo) {
      lo = lowOf(b);
      lowDate = b.date;
    }
  const nifty = await niftyCloses(rotationFetchYears() + 1);
  const study = studyWinner(bars, lowDate, nifty);
  const candles = bars.some((b) => b.high != null);
  const weeks = weekly(bars, candles).map((x) => ({ date: bars[x.last]!.date, open: x.open, high: x.high, low: x.low, close: x.close }));
  const days = bars.slice(-252).map((b) => ({
    date: b.date,
    open: candles ? (b.open ?? b.close) : b.close,
    high: candles ? (b.high ?? b.close) : b.close,
    low: candles ? (b.low ?? b.close) : b.close,
    close: b.close,
  }));
  const ipo = ipo2Analysis(t, market, nifty);
  let verdict = ipo?.verdict ?? null;
  // IPO V2.0 items the IPO2 engine doesn't read itself: the day-1 ignite bar and growth in the first quarters.
  if (verdict && ipo?.listed && ipo.listing_date) {
    const extra: Array<{ good: boolean; text: string }> = [];
    const ig = fetched ? igniteBar(fetched, ipo.listing_date, cachedRotationCloses(t, market, rotationFetchYears())) : null;
    if (ig)
      extra.push({
        good: ig.ignite,
        text: `${ig.ignite ? "Ignite bar on day 1" : "No ignite bar on day 1"}: ${ig.green ? "green" : "red"} candle ${ig.day_pct > 0 ? "+" : ""}${ig.day_pct}%, closed ${Math.round(
          ig.close_pos * 100,
        )}% up its range${ig.hve == null ? "" : ig.hve ? ", highest volume since listing" : ", not the highest volume since listing"}${
          ig.held == null ? "" : ig.held ? "; held the day-1 low for 8 weeks" : "; closed under the day-1 low within 8 weeks"
        }`,
      });
    const qs = quartersFor(t);
    const eg = qs ? earlyGrowth(qs, ipo.listing_date) : null;
    if (eg && eg.measured)
      extra.push({
        good: eg.ok === true,
        text: `Growth in the first quarters after listing: ${eg.strong} of ${eg.measured} with sales and profit both up ${IPO2_RULES.growthPct}%+ (${eg.quarters
          .filter((q) => q.sales_yoy != null && q.np_yoy != null)
          .map((q) => `${q.quarter}: ${q.sales_yoy}% / ${q.np_yoy}%`)
          .join(", ")})`,
      });
    verdict = { ...verdict, reasons: [...verdict.reasons, ...extra] };
  }
  return {
    ok: true,
    ticker: t,
    candles,
    weeks,
    days,
    study,
    ipo2_listed: ipo?.listed ?? false,
    ipo2: ipo?.entries ?? [],
    verdict,
    momentum: study ? momentumReasons(study) : [],
    stage_note: ipo?.stage_note ?? null,
    listing_date: ipo?.listing_date ?? null,
    issue_price: ipo?.issue_price ?? null,
    listing_gain_pct: ipo?.listing_gain_pct ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Ignite bar (IPO V2.0: "ignite bar formation on day 1")              */
/* ------------------------------------------------------------------ */

/**
 * Listing-day candle (IREDA "Ignite bar on IPO day", Jyoti CNC "respected the high range of the
 * ignite bar"): a green day-1 candle closing in the top half of its range, on the highest volume
 * since listing (HVE). "Top half" is our threshold; the notes give none. Held = no close
 * under the day-1 low in the first 8 weeks; where the lowest close sat inside the day-1 range is shown.
 */
export type Ignite = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Day-1 close vs its open, %. */
  day_pct: number;
  /** Close position in the day's range, 0 = low, 1 = high. */
  close_pos: number;
  green: boolean;
  /** Day-1 volume is the highest since listing (HVE). Null without saved volume. */
  hve: boolean | null;
  /** Lowest close of the next 40 sessions, as a position in the day-1 range (below 0 = under the low). */
  low_after_pos: number | null;
  held: boolean | null;
  ignite: boolean;
};

export function igniteBar(candles: Candle[], listing: string, volumes?: Array<{ date: string; volume?: number }>): Ignite | null {
  const i = candles.findIndex((b) => b.date >= listing);
  if (i < 0) return null;
  const d = candles[i]!;
  // Yahoo's first candle must be the listing day itself (within 3 days), with a real range.
  if (Date.parse(d.date) - Date.parse(listing) > 3 * 86_400_000 || d.high == null || d.low == null || d.open == null) return null;
  const range = d.high - d.low;
  if (!(range > 0)) return null;
  const pos = (v: number) => r1((v - d.low!) / range);
  let hve: boolean | null = null;
  if (volumes?.length) {
    const v = volumes.filter((b) => b.date >= listing && (b.volume ?? 0) > 0);
    if (v.length && v[0]!.date === d.date) hve = v.every((b) => (b.volume ?? 0) <= v[0]!.volume!);
  }
  const after = candles.slice(i + 1, i + 41);
  const lowAfter = after.length ? Math.min(...after.map((b) => b.close)) : null;
  const green = d.close > d.open;
  return {
    date: d.date,
    open: d.open,
    high: d.high,
    low: d.low,
    close: d.close,
    day_pct: r1((d.close / d.open - 1) * 100),
    close_pos: pos(d.close),
    green,
    hve,
    low_after_pos: lowAfter == null ? null : pos(lowAfter),
    held: lowAfter == null ? null : lowAfter >= d.low,
    // A real ignite bar closes strong: green, in the top half of its range, on the highest volume.
    ignite: green && d.close >= d.low + range / 2 && hve !== false,
  };
}

/** Saved candles only (no fetch), for screens. */
export function savedCandles(ticker: string, market: string): Candle[] | null {
  try {
    const db = ohlcDb();
    try {
      const row = db.prepare("SELECT bars FROM ohlc WHERE ticker = ? AND market = ?").get(ticker.toUpperCase(), market) as
        | { bars: string }
        | undefined;
      return row ? unpack(row.bars) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

let filling = false;
/** Fetch and save candles for these stocks in the background, two at a time (screens fill in on the next load). */
export function fillCandlesInBackground(items: Array<{ ticker: string; market: string }>): void {
  if (filling || !items.length) return;
  filling = true;
  void runConcurrent(items.slice(0, 600), 2, async (it) => {
    try {
      await winnerCandles(it.ticker, it.market);
    } catch {
      /* skip */
    }
  }).finally(() => {
    filling = false;
  });
}
