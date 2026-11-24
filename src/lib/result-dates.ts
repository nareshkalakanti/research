/**
 * Result-date helpers: the day a company announced results (never a quarter
 * period-end), and the share-price return since that day.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(raw: string | null | undefined): string | null {
  const d = (raw || "").slice(0, 10);
  return ISO_DAY.test(d) ? d : null;
}

export function isCalendarQuarterEnd(iso: string | null | undefined): boolean {
  const d = isoDay(iso);
  if (!d) return false;
  const md = d.slice(5, 10);
  return md === "03-31" || md === "06-30" || md === "09-30" || md === "12-31";
}

/** Announcement calendar day only — never quarter period-ends. */
export function usableAnnounceResultDate(raw: string | null | undefined): string | null {
  const d = isoDay(raw);
  if (!d || isCalendarQuarterEnd(d)) return null;
  return d;
}

function sortedCloses(bars: Array<{ date: string; close: number }>) {
  return bars
    .map((b) => ({ date: (b.date || "").slice(0, 10), close: b.close }))
    .filter((b) => ISO_DAY.test(b.date) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** First session close on or after the result date. */
export function resultEntryClose(
  bars: Array<{ date: string; close: number }>,
  resultDate: string | null | undefined,
): number | null {
  const rd = (resultDate || "").slice(0, 10);
  if (!ISO_DAY.test(rd) || !bars.length) return null;
  const hit = sortedCloses(bars).find((b) => b.date >= rd);
  return hit && hit.close > 0 ? hit.close : null;
}

/** Return since results: (current price − result-day close) / result-day close × 100. */
export function computeReturnsPct(
  bars: Array<{ date: string; close: number }>,
  resultDate: string | null | undefined,
  currentPrice?: number | null,
): number | null {
  const entry = resultEntryClose(bars, resultDate);
  if (entry == null || !(entry > 0)) return null;
  const sorted = sortedCloses(bars);
  if (!sorted.length) return null;
  const exit =
    currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : sorted[sorted.length - 1]!.close;
  if (!(exit > 0)) return null;
  return Math.round((exit / entry - 1) * 10000) / 100;
}
