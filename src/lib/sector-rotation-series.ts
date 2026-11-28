import type { Bar } from "./indicators";

export type SeriesPoint = { date: string; value: number };

export const ROTATION_RANGES = [
  "1D",
  "1W",
  "1M",
  "3M",
  "6M",
  "1Y",
  "5Y",
  "YTD",
] as const;
export type RotationRange = (typeof ROTATION_RANGES)[number];

export function rotationRangeDays(range: string): number {
  const key = (range || "6M").toUpperCase();
  // 1D/1W: calendar pad so prior sessions exist across weekends/holidays;
  // the % itself uses tradingSessionsForRange (1 / 5 sessions), not first→last.
  if (key === "1D") return 5;
  if (key === "1W") return 14;
  if (key === "1M") return 31;
  if (key === "3M") return 93;
  if (key === "1Y") return 370;
  if (key === "5Y") return 365 * 5;
  if (key === "YTD") return 370;
  return 186;
}

/** Trading sessions in the return for short chips; null = use full calendar window. */
export function tradingSessionsForRange(range?: string): number | null {
  const key = (range || "").toUpperCase();
  if (key === "1D") return 1;
  if (key === "1W") return 5;
  return null;
}

export const ROTATION_MA_PERIODS = [20, 50, 200] as const;

export function rotationMaLookbackStart(windowStart: string): string {
  const last = (windowStart || "").slice(0, 10);
  if (!last) return "1970-01-01";
  const period = Math.max(...ROTATION_MA_PERIODS);
  const d = new Date(`${last}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.ceil(period * 1.6));
  return d.toISOString().slice(0, 10);
}

export function rotationYearsBack(range: string): number {
  const key = (range || "6M").toUpperCase();
  const maYears = Math.max(1, Math.ceil((Math.max(...ROTATION_MA_PERIODS) * 1.6) / 365));
  if (key === "5Y") return 5 + maYears;
  if (key === "1Y" || key === "YTD") return 2 + maYears;
  return 1 + maYears;
}

/** Always pull enough OHLC for the longest chip + MA warm-up; shorter ranges window locally. */
export function rotationFetchYears(): number {
  return rotationYearsBack("5Y");
}

export function rotationMaxLookbackStart(lastDate: string): string {
  return rotationMaLookbackStart(rotationWindowStart(lastDate, "5Y"));
}

export function rotationWindowStart(lastDate: string, range: string): string {
  const last = (lastDate || "").slice(0, 10);
  if (!last) return "1970-01-01";
  const key = (range || "6M").toUpperCase();
  if (key === "YTD") return `${last.slice(0, 4)}-01-01`;
  const d = new Date(`${last}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - rotationRangeDays(key));
  return d.toISOString().slice(0, 10);
}

/** True when `points` begins on or before the window start (can slice locally). */
export function seriesCoversStart(
  points: SeriesPoint[],
  startDate: string,
): boolean {
  const first = points[0]?.date;
  const start = (startDate || "").slice(0, 10);
  return !!first && !!start && first <= start;
}

/** A window can open on a weekend or market holiday, so allow a short gap. */
const WINDOW_START_GRACE_DAYS = 4;

/**
 * Return over the last `sessions` trading steps (1D → 1, 1W → 5).
 * Points must already be ordered oldest→newest.
 */
export function sessionSpanReturnPct(
  points: SeriesPoint[],
  sessions: number,
): number | null {
  if (!Number.isFinite(sessions) || sessions < 1) return null;
  if (points.length < sessions + 1) return null;
  const a = points[points.length - 1 - sessions]?.value;
  const b = points[points.length - 1]?.value;
  if (a == null || b == null || !(a > 0) || !Number.isFinite(b)) return null;
  return ((b - a) / a) * 100;
}

/** Prior session → last session (%). */
export function lastSessionReturnPct(points: SeriesPoint[]): number | null {
  return sessionSpanReturnPct(points, 1);
}

/**
 * Return over the whole window, or null when price history starts too late
 * (recent listing, partial cache) or has fewer than two closes in the window.
 * Pass the full series, not one already cut to the window.
 * 1D / 1W use a fixed trading-session span (1 / 5), not calendar first→last.
 */
export function windowReturnPct(
  points: SeriesPoint[],
  startDate: string,
  range?: string,
): number | null {
  if (!startsInWindow(points[0]?.date, startDate)) return null;
  const win = windowRebaseSeries(points, startDate);
  const sessions = tradingSessionsForRange(range);
  if (sessions != null) return sessionSpanReturnPct(win, sessions);
  return win.length >= 2 ? seriesReturnPct(win) : null;
}

/** Sector / bench % for a range chip (1D/1W = session span; else full window). */
export function rangeSeriesReturnPct(
  windowed: SeriesPoint[],
  range: string,
): number | null {
  const sessions = tradingSessionsForRange(range);
  if (sessions != null) return sessionSpanReturnPct(windowed, sessions);
  return windowed.length >= 2 ? seriesReturnPct(windowed) : null;
}

function startsInWindow(firstDate: string | undefined, startDate: string): boolean {
  const first = firstDate?.slice(0, 10);
  const start = (startDate || "").slice(0, 10);
  if (!first || !start) return false;
  const gapDays =
    (Date.parse(`${first}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
    86_400_000;
  return gapDays <= WINDOW_START_GRACE_DAYS;
}

/** Closes span the whole window, so the stock can count toward a sector return. */
export function barsCoverWindow(
  bars: Array<{ date: string; close: number }>,
  startDate: string,
  range?: string,
): boolean {
  if (!startsInWindow(bars[0]?.date, startDate)) return false;
  const start = startDate.slice(0, 10);
  const sessions = tradingSessionsForRange(range);
  const need = sessions != null ? sessions + 1 : 2;
  return bars.filter((b) => b.date >= start && b.close > 0).length >= need;
}

/**
 * Window index with earlier history scaled onto it, so moving averages have
 * warm-up data while the visible line stays the true window index.
 */
export function stitchWarmup(
  long: SeriesPoint[],
  windowed: SeriesPoint[],
): SeriesPoint[] {
  const first = windowed[0];
  if (!first) return [];
  const anchor = long.find((p) => p.date >= first.date);
  if (!anchor || !(anchor.value > 0)) return windowed;
  const k = first.value / anchor.value;
  const warmup = long
    .filter((p) => p.date < first.date)
    .map((p) => ({ date: p.date, value: p.value * k }));
  return [...warmup, ...windowed];
}

/** Filter to `[startDate, …]` and rebase first point to `base`. */
export function windowRebaseSeries(
  points: SeriesPoint[],
  startDate: string,
  base = 100,
): SeriesPoint[] {
  const start = (startDate || "").slice(0, 10);
  const win = points.filter(
    (p) => p.date >= start && Number.isFinite(p.value) && p.value > 0,
  );
  const first = win[0];
  if (!first || !(first.value > 0)) return [];
  const k = base / first.value;
  return win.map((p) => ({ date: p.date, value: p.value * k }));
}

export function downsampleSeries(pts: SeriesPoint[], max = 72): SeriesPoint[] {
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1);
  const out: SeriesPoint[] = [];
  for (let i = 0; i < max; i++) {
    out.push(pts[Math.round(i * step)]!);
  }
  return out;
}

/** Close path rebased to `base` on the first bar in window. */
export function rebaseCloses(
  bars: Array<{ date: string; close: number }>,
  startDate: string,
  base = 100,
): SeriesPoint[] {
  const win = bars.filter(
    (b) =>
      b.date >= startDate && Number.isFinite(b.close) && b.close > 0,
  );
  const first = win[0];
  if (!first) return [];
  const px0 = first.close;
  if (!(px0 > 0)) return [];
  return win.map((b) => ({
    date: b.date,
    value: (b.close / px0) * base,
  }));
}

/**
 * Equal-weight average of rebased closes on dates any name has.
 * Forward-fills each member’s last rebased value so sparse / gappy names
 * cannot spike the basket on days when only they print.
 */
export function equalWeightIndex(
  members: Array<Array<{ date: string; close: number }>>,
  startDate: string,
  base = 100,
): SeriesPoint[] {
  const rebased = members
    .map((bars) => rebaseCloses(bars, startDate, base))
    .filter((s) => s.length >= 2);
  if (!rebased.length) return [];
  const dates = new Set<string>();
  for (const s of rebased) for (const p of s) dates.add(p.date);
  const ordered = [...dates].sort();
  const maps = rebased.map((s) => new Map(s.map((p) => [p.date, p.value])));
  const last = maps.map(() => null as number | null);
  const out: SeriesPoint[] = [];
  for (const date of ordered) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < maps.length; i++) {
      const v = maps[i]!.get(date);
      if (v != null && Number.isFinite(v)) last[i] = v;
      const cur = last[i];
      if (cur == null || !Number.isFinite(cur)) continue;
      sum += cur;
      n += 1;
    }
    if (n < 1) continue;
    out.push({ date, value: sum / n });
  }
  return out;
}

/**
 * Free-float / cap-weighted average of rebased closes. Falls back to equal weight.
 * Forward-fills missing closes (same as equal-weight) so gap days stay stable.
 */
export function capWeightIndex(
  members: Array<{
    bars: Array<{ date: string; close: number }>;
    mcap: number | null;
  }>,
  startDate: string,
  base = 100,
): SeriesPoint[] {
  const packed = members
    .map((m) => ({
      series: rebaseCloses(m.bars, startDate, base),
      w: m.mcap != null && Number.isFinite(m.mcap) && m.mcap > 0 ? m.mcap : 0,
    }))
    .filter((p) => p.series.length >= 2);
  const weighted = packed.filter((p) => p.w > 0);
  const use = weighted.length ? weighted : packed.map((p) => ({ ...p, w: 1 }));
  if (!use.length) return [];
  const dates = new Set<string>();
  for (const p of use) for (const pt of p.series) dates.add(pt.date);
  const ordered = [...dates].sort();
  const maps = use.map((p) => new Map(p.series.map((pt) => [pt.date, pt.value])));
  const last = maps.map(() => null as number | null);
  const out: SeriesPoint[] = [];
  for (const date of ordered) {
    let sum = 0;
    let wsum = 0;
    use.forEach((p, i) => {
      const v = maps[i]!.get(date);
      if (v != null && Number.isFinite(v)) last[i] = v;
      const cur = last[i];
      if (cur == null || !Number.isFinite(cur)) return;
      sum += cur * p.w;
      wsum += p.w;
    });
    if (wsum <= 0) continue;
    out.push({ date, value: sum / wsum });
  }
  return out;
}

export function seriesReturnPct(points: SeriesPoint[]): number | null {
  const a = points[0]?.value;
  const b = points[points.length - 1]?.value;
  if (a == null || b == null || !(a > 0)) return null;
  return ((b - a) / a) * 100;
}

export function clipBarsFromEnd(bars: Bar[], days: number): Bar[] {
  if (!bars.length) return [];
  const last = bars[bars.length - 1]!.date;
  const start = addCalendarDays(last, -Math.max(1, days));
  return bars.filter((b) => b.date >= start);
}

function addCalendarDays(iso: string, delta: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
