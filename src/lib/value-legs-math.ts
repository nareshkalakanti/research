/**
 * Shared Sales 3Y / ROCE 3Y math for Value + Portfolio (Screener annual columns).
 * Prefer calendar 3Y when endpoints are positive; otherwise true 3Y across
 * positive FY only (needs 4 positive years). No 1Y/2Y jumps labeled as 3Y.
 */

/** Ranking-safe Sales CAGR bounds (aligned with Upstox). */
const SALES3Y_MIN = -90;
const SALES3Y_MAX = 150;
/** Drop absurd multiples from tiny / mis-scaled bases. */
const MAX_MULTIPLE = 20;
/** Min start-year sales (₹ Cr) — same idea as Upstox MIN_REV_CR. */
const MIN_SALES_CR = 1;

/**
 * 3-year sales CAGR (%) from full-year sales columns (oldest → newest).
 * Zero early years: only a true 3Y span of positive FY counts (4 points).
 */
export function sales3yFromAnnual(sales: Array<number | null | undefined>): number | null {
  const n = sales.length;
  if (n < 2) return null;
  const end = sales[n - 1];
  if (end == null || !Number.isFinite(end) || end <= 0) return null;

  if (n >= 4) {
    const start = sales[n - 4];
    if (start != null && Number.isFinite(start) && start > 0) {
      return salesCagrPct(end, start, 3);
    }
  } else if (n === 3) {
    // Young listing with only 3 FY columns → 2Y CAGR (explicitly shorter).
    const start = sales[0];
    if (start != null && Number.isFinite(start) && start > 0) {
      return salesCagrPct(end, start, 2);
    }
  }

  const vals = sales.filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  // True 3Y only: need 4 positive FY points (span 3). Shorter positive runs → null.
  if (vals.length < 4) return null;
  const latest = vals[vals.length - 1]!;
  const prior = vals[vals.length - 1 - 3]!;
  return salesCagrPct(latest, prior, 3);
}

function salesCagrPct(end: number, start: number, yrs: number): number | null {
  if (!(start > 0) || !(end > 0) || yrs < 1) return null;
  if (start < MIN_SALES_CR) return null;
  if (end / start > MAX_MULTIPLE || start / end > MAX_MULTIPLE) return null;
  return clampSalesCagr((Math.pow(end / start, 1 / yrs) - 1) * 100);
}

function clampSalesCagr(cagr: number): number | null {
  if (!Number.isFinite(cagr) || cagr < SALES3Y_MIN || cagr > SALES3Y_MAX) return null;
  return cagr;
}

/**
 * Average ROCE over the last up to 3 full-year columns (one year is enough).
 */
export function roce3yFromAnnual(roce: Array<number | null | undefined>): number | null {
  const last3 = roce
    .slice(-3)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (!last3.length) return null;
  return last3.reduce((x, y) => x + y, 0) / last3.length;
}
