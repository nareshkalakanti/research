/**
 * Stock detail card metrics — mcap from live price × shares, TTM PE,
 * unusual-quarter flags, and QoQ cell tones. Generic (no issuer cases).
 */

export const MCAP_STALE_TOL = 0.005; // 0.5%
export const PE_MATCH_TOL = 0.01; // 1%
export const UNUSUAL_Q_OFF = 0.3; // 30% vs prior 3Q avg

export function impliedShares(
  mcapCr: number | null | undefined,
  price: number | null | undefined,
): number | null {
  if (mcapCr == null || price == null) return null;
  if (!(mcapCr > 0) || !(price > 0)) return null;
  return (mcapCr * 1e7) / price;
}

/** Market cap in ₹ Cr from live price × share count. */
export function liveMcapCr(
  price: number | null | undefined,
  shares: number | null | undefined,
): number | null {
  if (price == null || shares == null) return null;
  if (!(price > 0) || !(shares > 0)) return null;
  return (price * shares) / 1e7;
}

export function mcapDisagrees(
  storedCr: number | null | undefined,
  liveCr: number | null | undefined,
  tol = MCAP_STALE_TOL,
): boolean {
  if (storedCr == null || liveCr == null) return false;
  if (!(storedCr > 0) || !(liveCr > 0)) return false;
  return Math.abs(liveCr - storedCr) / storedCr > tol;
}

export function ttmEps(epsValues: Array<number | null | undefined>): number | null {
  const eps = epsValues
    .map((v) => (v != null && Number.isFinite(v) ? v : null))
    .filter((v): v is number => v != null);
  if (eps.length < 4) {
    if (!eps.length) return null;
    const sum = eps.reduce((a, b) => a + b, 0);
    return Number.isFinite(sum) ? sum : null;
  }
  return eps.slice(-4).reduce((a, b) => a + b, 0);
}

export function trailingPeFromTtm(
  price: number | null | undefined,
  ttm: number | null | undefined,
): number | null {
  if (price == null || ttm == null) return null;
  if (!(price > 0) || !(ttm > 0)) return null;
  return Math.round((price / ttm) * 10) / 10;
}

/** Mean of the three values immediately before tip (index tipIdx). */
export function priorThreeAvg(
  values: Array<number | null | undefined>,
  tipIdx: number,
): number | null {
  if (tipIdx < 3) return null;
  const slice = values.slice(tipIdx - 3, tipIdx);
  const nums = slice.filter(
    (v): v is number => v != null && Number.isFinite(v),
  );
  if (nums.length < 3) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** True when tip is more than `off` away from the prior 3-quarter average. */
export function quarterUnusual(
  values: Array<number | null | undefined>,
  tipIdx?: number,
  off = UNUSUAL_Q_OFF,
): boolean {
  const i = tipIdx ?? values.length - 1;
  const tip = values[i];
  if (tip == null || !Number.isFinite(tip)) return false;
  const avg = priorThreeAvg(values, i);
  if (avg == null || avg === 0) return false;
  return Math.abs(tip - avg) / Math.abs(avg) > off;
}

/**
 * TTM PE after replacing tip EPS with the prior-3 average (when tip EPS is
 * unusual). Used for "normalised PE" beside a flagged print.
 */
export function normalisedTtmEps(
  epsValues: Array<number | null | undefined>,
): number | null {
  const tipIdx = epsValues.length - 1;
  if (tipIdx < 3) return ttmEps(epsValues);
  const avg = priorThreeAvg(epsValues, tipIdx);
  if (avg == null) return ttmEps(epsValues);
  const patched = [...epsValues];
  patched[tipIdx] = avg;
  return ttmEps(patched);
}

export function normalisedTrailingPe(
  price: number | null | undefined,
  epsValues: Array<number | null | undefined>,
): number | null {
  return trailingPeFromTtm(price, normalisedTtmEps(epsValues));
}

export type QoqTone = "q-up" | "q-down" | "q-flat" | "";

/** First column is always neutral; else colour by QoQ sign (good_up rows). */
export function qoqCellTone(
  cur: number | null | undefined,
  prev: number | null | undefined,
  colIndex: number,
  goodUp = true,
): QoqTone {
  if (colIndex <= 0) return "";
  if (cur == null || prev == null) return "";
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return "";
  if (cur > prev) return goodUp ? "q-up" : "q-down";
  if (cur < prev) return goodUp ? "q-down" : "q-up";
  return "q-flat";
}

export function qoqChangePct(
  cur: number | null | undefined,
  prev: number | null | undefined,
): number | null {
  if (cur == null || prev == null) return null;
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  if (prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/** Percentage points for OPM-style rows (absolute delta). */
export function qoqChangePp(
  cur: number | null | undefined,
  prev: number | null | undefined,
): number | null {
  if (cur == null || prev == null) return null;
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  return cur - prev;
}

export function pctFromHigh(
  price: number | null | undefined,
  high52: number | null | undefined,
): number | null {
  if (price == null || high52 == null) return null;
  if (!(price > 0) || !(high52 > 0)) return null;
  return Math.round(((price / high52 - 1) * 100) * 100) / 100;
}

export function withinTol(
  a: number,
  b: number,
  tol: number,
): boolean {
  if (!(a > 0) || !(b > 0)) return Math.abs(a - b) <= tol;
  return Math.abs(a - b) / Math.abs(b) <= tol;
}
