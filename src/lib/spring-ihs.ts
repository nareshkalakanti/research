/**
 * Spring + inverse H&S breakout (long) — generic bar math, no issuer facts.
 *
 * Context: close < SMA(100)
 * Spring: low < prior 60-bar low × 0.995, reclaim within 3 bars; head = window low
 * RS: ≥5 bars after spring, RS low > head, any low < head cancels, expires 80 bars
 * Neckline: last two confirmed pivot highs (window 4, +4 lag), negative slope, projected
 * Trigger: close > neckline, +DI>-DI, ADX rising vs 3 bars ago, vol ≥ 1.3×20d avg
 * Enter next open; stop = RS − 0.5×ATR14; target = NL + (NL − head); RR ≥ 1.5
 */
import {
  adx,
  atr,
  rollingMean,
  type Bar,
} from "./indicators";

export type SpringIhsHit = {
  signal: 1;
  /** Trigger bar date (YYYY-MM-DD). */
  date: string;
  /** Suggested entry: next open when known, else trigger close. */
  entry: number;
  entry_kind: "next_open" | "close_proxy";
  head: number;
  rs_low: number;
  neckline: number;
  stop: number;
  target: number;
  rr: number;
  spring_date: string;
  rs_date: string;
  pivot_a_date: string;
  pivot_b_date: string;
};

export type SpringIhsRow = SpringIhsHit & {
  ticker: string;
  name: string;
  market: string;
};

const SMA_LEN = 100;
const PRIOR_LOW_LOOKBACK = 60;
const SPRING_THRESH = 0.995;
const RECLAIM_BARS = 3;
const RS_MIN_AFTER = 5;
const SETUP_EXPIRE = 80;
const PIVOT_WIN = 4;
const PIVOT_LAG = 4;
const ADX_LEN = 14;
const ATR_LEN = 14;
const VOL_MA = 20;
const VOL_MULT = 1.3;
const MIN_RR = 1.5;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Pivot high at i confirmed only once bar i+PIVOT_LAG is in. */
function isPivotHigh(highs: number[], i: number): boolean {
  const lo = i - PIVOT_WIN;
  const hi = i + PIVOT_WIN;
  if (lo < 0 || hi >= highs.length) return false;
  const v = highs[i]!;
  for (let k = lo; k <= hi; k += 1) {
    if (k === i) continue;
    if (highs[k]! >= v) return false;
  }
  return true;
}

/** Confirmed pivot-high indices with i + lag <= asOf. */
function confirmedPivotHighs(highs: number[], asOf: number): number[] {
  const out: number[] = [];
  const last = asOf - PIVOT_LAG;
  for (let i = PIVOT_WIN; i <= last; i += 1) {
    if (isPivotHigh(highs, i)) out.push(i);
  }
  return out;
}

function necklineAt(
  highs: number[],
  asOf: number,
): { value: number; a: number; b: number } | null {
  const pivots = confirmedPivotHighs(highs, asOf);
  if (pivots.length < 2) return null;
  const a = pivots[pivots.length - 2]!;
  const b = pivots[pivots.length - 1]!;
  if (b <= a) return null;
  const ha = highs[a]!;
  const hb = highs[b]!;
  const slope = (hb - ha) / (b - a);
  if (!(slope < 0)) return null;
  const value = ha + slope * (asOf - a);
  if (!Number.isFinite(value)) return null;
  return { value, a, b };
}

type Spring = {
  springIdx: number;
  reclaimIdx: number;
  head: number;
  priorLow: number;
};

function findSprings(bars: Bar[], sma100: (number | null)[]): Spring[] {
  const out: Spring[] = [];
  const n = bars.length;
  for (let s = PRIOR_LOW_LOOKBACK; s < n; s += 1) {
    const sma = sma100[s];
    if (sma == null || !(bars[s]!.close < sma)) continue;

    let priorLow = Infinity;
    for (let k = s - PRIOR_LOW_LOOKBACK; k < s; k += 1) {
      priorLow = Math.min(priorLow, bars[k]!.low);
    }
    if (!Number.isFinite(priorLow) || priorLow <= 0) continue;
    if (!(bars[s]!.low < priorLow * SPRING_THRESH)) continue;

    let reclaimIdx = -1;
    const end = Math.min(n - 1, s + RECLAIM_BARS - 1);
    for (let j = s; j <= end; j += 1) {
      if (bars[j]!.close > priorLow) {
        reclaimIdx = j;
        break;
      }
    }
    if (reclaimIdx < 0) continue;

    let head = Infinity;
    for (let j = s; j <= reclaimIdx; j += 1) {
      head = Math.min(head, bars[j]!.low);
    }
    if (!Number.isFinite(head)) continue;
    out.push({ springIdx: s, reclaimIdx, head, priorLow });
  }
  return out;
}

/**
 * Right-shoulder window after spring: lows stay above head; RS low is the
 * trough from spring+5 through the bar before trigger.
 */
function rightShoulder(
  bars: Bar[],
  spring: Spring,
  triggerIdx: number,
): { rsLow: number; rsIdx: number } | null {
  const s = spring.springIdx;
  if (triggerIdx - s < RS_MIN_AFTER) return null;
  if (triggerIdx - s > SETUP_EXPIRE) return null;

  const start = s + RS_MIN_AFTER;
  const end = triggerIdx - 1;
  if (end < start) return null;

  let rsLow = Infinity;
  let rsIdx = -1;
  for (let j = s + 1; j <= triggerIdx; j += 1) {
    const low = bars[j]!.low;
    if (low < spring.head) return null;
    if (j >= start && j <= end && low <= rsLow) {
      rsLow = low;
      rsIdx = j;
    }
  }
  if (rsIdx < 0 || !Number.isFinite(rsLow) || !(rsLow > spring.head)) {
    return null;
  }
  return { rsLow, rsIdx };
}

function triggerOk(
  bars: Bar[],
  i: number,
  neck: number,
  diPlus: (number | null)[],
  diMinus: (number | null)[],
  adxLine: (number | null)[],
  volMa: (number | null)[],
): boolean {
  const bar = bars[i]!;
  if (!(bar.close > neck)) return false;
  const p = diPlus[i];
  const m = diMinus[i];
  if (p == null || m == null || !(p > m)) return false;
  const a0 = adxLine[i];
  const a3 = i >= 3 ? adxLine[i - 3] : null;
  if (a0 == null || a3 == null || !(a0 > a3)) return false;
  const vma = volMa[i];
  if (vma == null || vma <= 0) return false;
  if (!(bar.volume >= VOL_MULT * vma)) return false;
  return true;
}

/** All valid long triggers on the series (oldest → newest). */
export function scanSpringIhsLong(bars: Bar[]): SpringIhsHit[] {
  if (bars.length < SMA_LEN + PRIOR_LOW_LOOKBACK + SETUP_EXPIRE) return [];

  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const vols = bars.map((b) => b.volume);
  const sma100 = rollingMean(closes, SMA_LEN);
  const volMa = rollingMean(vols, VOL_MA);
  const atr14 = atr(bars, ATR_LEN);
  const { adx: adxLine, diPlus, diMinus } = adx(bars, ADX_LEN);
  const springs = findSprings(bars, sma100);

  const hits: SpringIhsHit[] = [];
  const n = bars.length;

  for (let t = SMA_LEN; t < n; t += 1) {
    const neck = necklineAt(highs, t);
    if (!neck) continue;
    if (
      !triggerOk(bars, t, neck.value, diPlus, diMinus, adxLine, volMa)
    ) {
      continue;
    }

    const atrV = atr14[t];
    if (atrV == null || atrV <= 0) continue;

    // Prefer the most recent valid spring that still owns this breakout.
    let best: SpringIhsHit | null = null;
    for (let si = springs.length - 1; si >= 0; si -= 1) {
      const spring = springs[si]!;
      if (spring.springIdx >= t) continue;
      const rs = rightShoulder(bars, spring, t);
      if (!rs) continue;

      const head = spring.head;
      const rs_low = rs.rsLow;
      const neckline = neck.value;
      const stop = rs_low - 0.5 * atrV;
      const target = neckline + (neckline - head);
      const hasNext = t + 1 < n;
      const entry = hasNext ? bars[t + 1]!.open : bars[t]!.close;
      const entry_kind = hasNext ? ("next_open" as const) : ("close_proxy" as const);
      if (!(entry > stop) || !(target > entry)) continue;
      const rr = (target - entry) / (entry - stop);
      if (!(rr >= MIN_RR)) continue;

      best = {
        signal: 1,
        date: bars[t]!.date.slice(0, 10),
        entry: round2(entry),
        entry_kind,
        head: round2(head),
        rs_low: round2(rs_low),
        neckline: round2(neckline),
        stop: round2(stop),
        target: round2(target),
        rr: round4(rr),
        spring_date: bars[spring.springIdx]!.date.slice(0, 10),
        rs_date: bars[rs.rsIdx]!.date.slice(0, 10),
        pivot_a_date: bars[neck.a]!.date.slice(0, 10),
        pivot_b_date: bars[neck.b]!.date.slice(0, 10),
      };
      break;
    }
    if (best) hits.push(best);
  }

  return hits;
}

/** Latest hit on the series, optionally requiring the tip bar. */
export function latestSpringIhsLong(
  bars: Bar[],
  opts?: { tipOnly?: boolean; lookbackBars?: number },
): SpringIhsHit | null {
  const hits = scanSpringIhsLong(bars);
  if (!hits.length) return null;
  const last = hits[hits.length - 1]!;
  if (opts?.tipOnly) {
    const tip = bars[bars.length - 1]?.date.slice(0, 10);
    if (last.date !== tip) return null;
  }
  if (opts?.lookbackBars != null && opts.lookbackBars > 0 && bars.length) {
    const tipIdx = bars.length - 1;
    const hitIdx = bars.findIndex((b) => b.date.slice(0, 10) === last.date);
    if (hitIdx < 0 || tipIdx - hitIdx > opts.lookbackBars) return null;
  }
  return last;
}
