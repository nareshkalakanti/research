/** Post-concall-announcement drift — price and baseline must be from the same board. */

import { INDIA_TZ } from "../nse-time";

const NSE_OPEN_MIN = 9 * 60 + 15;

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

/** IST civil day + minutes-from-midnight for an event timestamp. */
export function istEventClock(iso: string): { ymd: string; minutes: number } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const ymd = iso.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
    return { ymd, minutes: 0 };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "0";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
  };
}

function addCalendarDay(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(y!, m! - 1, d! + delta));
  return utc.toISOString().slice(0, 10);
}

function isWeekdayYmd(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return dow !== 0 && dow !== 6;
}

function nextWeekdayYmd(ymd: string): string {
  let cur = addCalendarDay(ymd, 1);
  for (let i = 0; i < 10; i++) {
    if (isWeekdayYmd(cur)) return cur;
    cur = addCalendarDay(cur, 1);
  }
  return cur;
}

/** NSE sessions only — drop Yahoo weekend / stub bars that fake a post-call day. */
function uniqueBarDays(bars: Array<{ date: string }>): string[] {
  return [
    ...new Set(
      bars
        .map((b) => b.date.slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && isWeekdayYmd(d)),
    ),
  ].sort();
}

/**
 * Exclusive upper bound on bar dates for the post-concall baseline.
 * Bars with date < cutoff contribute; the last such close is the baseline.
 *
 * Post-concall drift starts *after* the call session is done — not from the
 * prior day (that would bake in the announcement-day move).
 *
 * - Call on a trading day (before open / during / after close) → that day's close
 *   once its bar exists; until then falls through to prior close
 * - Weekend / holiday → prior trading day's close
 */
export function baselineBarCutoffYmd(
  eventAt: string,
  tradingDays: string[],
): string {
  const { ymd } = istEventClock(eventAt);
  if (tradingDays.includes(ymd)) return addCalendarDay(ymd, 1);
  return ymd;
}

/**
 * Close of the call session (post-concall anchor).
 * Uses bar dates as the trading calendar (holidays = missing bars).
 */
export function baselineCloseBefore(
  bars: Array<{ date: string; close: number }>,
  eventAt: string,
): number | null {
  if (!bars.length) return null;
  const days = uniqueBarDays(bars);
  const cutoff = baselineBarCutoffYmd(eventAt, days);
  let last: number | null = null;
  for (const bar of bars) {
    const d = bar.date.slice(0, 10);
    if (!isWeekdayYmd(d) || d >= cutoff) continue;
    if (bar.close > 0) last = bar.close;
  }
  return last;
}

/**
 * True once a session *after* the call-day close can move LTP.
 * Baseline is call-day close → same-day LTP≈close prints a fake 0%; need a later bar.
 * Weekend Yahoo stubs are ignored (weekday-only calendar).
 */
export function hasPostCallTradingSession(
  bars: Array<{ date: string }>,
  eventAt: string,
): boolean {
  const days = uniqueBarDays(bars);
  if (!days.length) return false;
  const { ymd } = istEventClock(eventAt);
  return days.some((d) => d > ymd);
}

/**
 * First weekday when LTP can differ from call-day close (always next session).
 */
export function driftReactionWeekdayYmd(eventAt: string): string {
  const { ymd } = istEventClock(eventAt);
  return nextWeekdayYmd(ymd);
}

/**
 * Show a drift % only after the reaction session has opened (IST).
 * Without bars: weekday approximation (Mon–Fri); holidays may unlock a day early.
 */
export function driftPctDisplayReady(
  eventAt: string,
  now: Date = new Date(),
): boolean {
  const reaction = driftReactionWeekdayYmd(eventAt);
  const n = istEventClock(now.toISOString());
  if (n.ymd > reaction) return true;
  if (n.ymd < reaction) return false;
  return n.minutes >= NSE_OPEN_MIN;
}

/**
 * Last close before the NSE concall/meet *announcement* day.
 * Ignores intimations filed before the results day (not post-call).
 */
export function concallAnnouncementBaseline(
  bars: Array<{ date: string; close: number }>,
  concallAt: string | null | undefined,
  earnAt: string,
): number | null {
  if (!concallAt) return null;
  if (istEventClock(concallAt).ymd < istEventClock(earnAt).ymd) return null;
  return baselineCloseBefore(bars, concallAt);
}
