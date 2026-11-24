import type { Close } from "./rotation-bars";

/**
 * TechnoFunda-style Price Action screen. The site does not publish its rules;
 * these thresholds were inferred from its screenshots and an old export (see
 * notes/price-action-screen.md). S2 has a further condition we could not see,
 * so our S2 passes more stocks than theirs.
 */
export const PA_RULES = {
  /** S4: day change at least this (%). Lowest S4 seen 8.18%, highest non-S4 7.91%. */
  s4DayPct: 8,
  /** S3: day change (%), volume vs the previous 5-day average, 3-month return (%). */
  s3DayPct: 4.7,
  /** NRB passed S3 at 1.998x, so the cut sits just under 2x. */
  s3VolX: 1.95,
  s3Ret3mPct: 19,
  /** S2: 1-month return (%). Their S2 also has an unknown second condition. */
  s2Ret1mPct: 10,
} as const;

/** 2WK view: 11 trading days, both end dates included (their 13–27 Jul view). */
export const PA_2WK_DAYS = 11;
/** Custom dates cap: about 3 months of trading days. */
export const PA_MAX_DAYS = 66;

/** Bits per day: S1 = 1, S2 = 2, S3 = 4, S4 = 8. 0 = traded, passed nothing. -1 = no trade that day. */
export type PaDay = number;

export type PaMetrics = {
  day_pct: number | null;
  vol_x: number | null;
  ret_1m: number | null;
  ret_3m: number | null;
};

export type PaRow = {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  industry: string | null;
  website: string | null;
  mcap_cr: number | null;
  /** Large = top 100 by market cap, Mid = 101–250, Small = the rest (SEBI style). */
  cap_class: "Large" | "Mid" | "Small" | null;
  price: number | null;
  days: PaDay[];
  trending: number;
  streak: number;
  /** Metrics on the last day of the window. */
  last: PaMetrics;
  has_volume: boolean;
  /** 52-week closing high within the last 10 trading days of the window. */
  rocket_price: boolean;
  /** Weighted RPI (estimate) at a 52-week high within the last 10 trading days. */
  rocket_rpi: boolean;
  wrpi: number | null;
};

export type PaResult = {
  dates: string[];
  rows: PaRow[];
  universe: number;
  /** Stocks whose cached series has no volume yet (S3 cannot pass for them). */
  no_volume: number;
  refreshing: number;
  rules: typeof PA_RULES;
  rockets: typeof PA_ROCKETS;
};

function shiftMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/** Index of the last bar dated on or before `date`, or -1. */
export function idxOnOrBefore(bars: Close[], date: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function retSince(bars: Close[], i: number, months: number): number | null {
  const j = idxOnOrBefore(bars, shiftMonths(bars[i]!.date, months));
  // No close near the start (recent listing): no return.
  if (j < 0) return null;
  const gap = (Date.parse(shiftMonths(bars[i]!.date, months)) - Date.parse(bars[j]!.date)) / 86_400_000;
  if (gap > 10) return null;
  const a = bars[j]!.close;
  return a > 0 ? (bars[i]!.close / a - 1) * 100 : null;
}

export function dayMetrics(bars: Close[], i: number): PaMetrics {
  const cur = bars[i];
  const prev = bars[i - 1];
  const day_pct = cur && prev && prev.close > 0 ? (cur.close / prev.close - 1) * 100 : null;
  let vol_x: number | null = null;
  if (cur?.volume != null && i >= 5) {
    let sum = 0;
    let ok = true;
    for (let k = i - 5; k < i; k++) {
      const v = bars[k]!.volume;
      if (v == null) {
        ok = false;
        break;
      }
      sum += v;
    }
    const avg = sum / 5;
    if (ok && avg > 0) vol_x = cur.volume / avg;
  }
  return {
    day_pct,
    vol_x,
    ret_1m: cur ? retSince(bars, i, 1) : null,
    ret_3m: cur ? retSince(bars, i, 3) : null,
  };
}

export function screenBits(m: PaMetrics): number {
  const s4 = m.day_pct != null && m.day_pct >= PA_RULES.s4DayPct;
  const s3 =
    m.day_pct != null &&
    m.day_pct >= PA_RULES.s3DayPct &&
    m.vol_x != null &&
    m.vol_x >= PA_RULES.s3VolX &&
    m.ret_3m != null &&
    m.ret_3m >= PA_RULES.s3Ret3mPct;
  const s2 = m.ret_1m != null && m.ret_1m >= PA_RULES.s2Ret1mPct;
  const s1 = s3 && s4;
  return (s1 ? 1 : 0) | (s2 ? 2 : 0) | (s3 ? 4 : 0) | (s4 ? 8 : 0);
}

// ---- Rockets ---------------------------------------------------------------------------
// Badges, not part of the green-day rule. Neither is defined publicly; these
// follow the screenshots: SMLISUZU had the price rocket 5.7% below its high
// (so it marks a recent new high, not "near the high"), and Shardacrop had the
// W.RPI rocket while 41% below its price high.

export const PA_ROCKETS = {
  /** A new high counts if it happened within this many trading days. */
  recentDays: 10,
  /** 52 weeks in trading days. */
  yearDays: 252,
  /** Weighted RPI periods in trading days: 2W, 3M, 6M, 1Y vs Nifty 50. */
  rpiPeriods: [10, 63, 126, 252],
  /** Their weights are not public: equal weights are a placeholder. */
  rpiWeights: [0.25, 0.25, 0.25, 0.25],
} as const;

/** True when some close in the last `recentDays` (ending at i) was a 52-week closing high. */
export function priceHighRocket(bars: Close[], i: number): boolean {
  const { recentDays, yearDays } = PA_ROCKETS;
  for (let k = Math.max(yearDays, i - recentDays + 1); k <= i; k++) {
    const c = bars[k]!.close;
    let high = -Infinity;
    for (let j = k - yearDays; j < k; j++) if (bars[j]!.close > high) high = bars[j]!.close;
    if (c >= high) return true;
  }
  return false;
}

/** Weighted RPI at bar k: weighted mean of (stock return / index return) x 100. */
export function weightedRpi(bars: Close[], k: number, indexAt: (date: string) => number | null): number | null {
  const { rpiPeriods, rpiWeights } = PA_ROCKETS;
  const ix = indexAt(bars[k]!.date);
  if (ix == null) return null;
  let sum = 0;
  for (let p = 0; p < rpiPeriods.length; p++) {
    const j = k - rpiPeriods[p]!;
    if (j < 0) return null;
    const ix0 = indexAt(bars[j]!.date);
    const s0 = bars[j]!.close;
    if (ix0 == null || !(s0 > 0) || !(ix0 > 0)) return null;
    sum += rpiWeights[p]! * ((bars[k]!.close / s0) / (ix / ix0)) * 100;
  }
  return sum;
}

/** Weighted RPI now, and whether it made a 52-week high within the last `recentDays`. */
export function rpiRocket(
  bars: Close[],
  i: number,
  indexAt: (date: string) => number | null,
): { wrpi: number | null; rocket: boolean } {
  const { recentDays, yearDays } = PA_ROCKETS;
  const from = i - recentDays - yearDays + 1;
  const series: Array<number | null> = [];
  for (let k = Math.max(0, from); k <= i; k++) series.push(weightedRpi(bars, k, indexAt));
  const wrpi = series[series.length - 1] ?? null;
  if (from < 0) return { wrpi, rocket: false };
  let rocket = false;
  for (let r = yearDays; r < series.length && !rocket; r++) {
    const v = series[r];
    if (v == null) continue;
    let high = -Infinity;
    for (let j = r - yearDays; j < r; j++) {
      const x = series[j];
      if (x != null && x > high) high = x;
    }
    if (high > -Infinity && v >= high) rocket = true;
  }
  return { wrpi, rocket };
}
