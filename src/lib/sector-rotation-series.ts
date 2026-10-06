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
  if (key === "1D") return 5;
  if (key === "1W") return 8;
  if (key === "1M") return 31;
  if (key === "3M") return 93;
  if (key === "1Y") return 370;
  if (key === "5Y") return 365 * 5;
  if (key === "YTD") return 370;
  return 186;
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

export function rotationWindowStart(lastDate: string, range: string): string {
  const last = (lastDate || "").slice(0, 10);
  if (!last) return "1970-01-01";
  const key = (range || "6M").toUpperCase();
  if (key === "YTD") return `${last.slice(0, 4)}-01-01`;
  const d = new Date(`${last}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - rotationRangeDays(key));
  return d.toISOString().slice(0, 10);
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

/** Equal-weight average of rebased closes on dates any name has. */
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
  const out: SeriesPoint[] = [];
  for (const date of ordered) {
    let sum = 0;
    let n = 0;
    for (const m of maps) {
      const v = m.get(date);
      if (v == null || !Number.isFinite(v)) continue;
      sum += v;
      n += 1;
    }
    if (n < 1) continue;
    out.push({ date, value: sum / n });
  }
  return out;
}

/** Free-float / cap-weighted average of rebased closes. Falls back to equal weight. */
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
  const out: SeriesPoint[] = [];
  for (const date of ordered) {
    let sum = 0;
    let wsum = 0;
    use.forEach((p, i) => {
      const v = maps[i]!.get(date);
      if (v == null || !Number.isFinite(v)) return;
      sum += v * p.w;
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
