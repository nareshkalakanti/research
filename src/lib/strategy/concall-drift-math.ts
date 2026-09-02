/** Post-earn drift math — price and baseline must be from the same board. */

export function computeDriftPct(
  ltp: number | null | undefined,
  baseline: number | null,
): number | null {
  if (ltp == null || baseline == null || baseline <= 0) return null;
  return Math.round(((ltp - baseline) / baseline) * 1000) / 10;
}

/** Reject ghost Yahoo .NS quotes paired with a different price series. */
export function priceBaselineConsistent(
  price: number | null | undefined,
  baseline: number | null | undefined,
): boolean {
  if (price == null || baseline == null || baseline <= 0 || price <= 0) return false;
  const ratio = price / baseline;
  // Legitimate post-earn moves rarely exceed ~80%; ghost stubs are often 5–20× off.
  if (ratio > 2.5 || ratio < 0.4) return false;
  const drift = computeDriftPct(price, baseline);
  if (drift != null && Math.abs(drift) > 120) return false;
  return true;
}

export function baselineCloseBefore(
  bars: Array<{ date: string; close: number }>,
  earnAt: string,
): number | null {
  const earnDay = earnAt.slice(0, 10);
  let last: number | null = null;
  for (const bar of bars) {
    if (bar.date.slice(0, 10) < earnDay) last = bar.close;
    else break;
  }
  return last;
}
