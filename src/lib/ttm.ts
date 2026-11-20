/**
 * Trailing twelve months from dated results. "Last 4 rows" is not a year when
 * a company files half-yearly (SME: 4 rows = 2 years) or has gaps in its
 * history — so pick the rows by date:
 *   4 consecutive quarters (≈3 months apart), else
 *   2 consecutive half-years (≈6 months apart),
 * and the newest must be recent. Otherwise null (callers fall back to annual).
 */
const monthIndex = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));

/** Newest result must have ended within this many days. */
export const TTM_MAX_AGE_DAYS = 300;

export function trailingYear<T extends { date: string }>(
  rows: readonly T[],
  now = Date.now(),
  /** Row has the figure being summed (pass all rows, not a pre-filtered list, so gaps are seen). */
  has: (r: T) => boolean = () => true,
): T[] | null {
  const xs = rows.filter((r) => /^\d{4}-\d{2}/.test(r.date)).slice().sort((a, b) => a.date.localeCompare(b.date));
  const newest = xs.at(-1);
  if (!newest || !has(newest)) return null;
  if ((now - Date.parse(`${newest.date.slice(0, 10)}T00:00:00Z`)) / 86_400_000 > TTM_MAX_AGE_DAYS) return null;
  const steps = (ys: T[], gap: number) => ys.every((y, i) => i === 0 || Math.abs(monthIndex(y.date) - monthIndex(ys[i - 1]!.date) - gap) <= 1);
  const q = xs.slice(-4);
  if (q.length === 4 && steps(q, 3)) return q.every(has) ? q : null;
  // Half-yearly only when the filing rhythm itself is half-yearly (the row
  // before is 6 months back too, or there is none) — not a quarterly filer
  // with one quarter missing.
  const h = xs.slice(-3);
  if (h.length >= 2 && steps(h, 6)) {
    const two = h.slice(-2);
    return two.every(has) ? two : null;
  }
  return null;
}
