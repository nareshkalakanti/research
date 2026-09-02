import fs from "fs";
import path from "path";

export type Nifty500TurnoverPoint = {
  month: string;
  volume_kcr: number;
  ma_kcr: number | null;
};

export type Nifty500TurnoverSeries = {
  built_at: string;
  constituents: number;
  years_back: number;
  series: Nifty500TurnoverPoint[];
  latest: { volume_kcr: number; ma_kcr: number | null; month: string };
};

const DATA_FILE = path.join(
  process.cwd(),
  "data",
  "nifty500_monthly_turnover.json",
);

export function nifty500TurnoverPath(): string {
  return DATA_FILE;
}

export function loadNifty500TurnoverSeries(): Nifty500TurnoverSeries | null {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as Nifty500TurnoverSeries;
    if (!Array.isArray(parsed.series) || !parsed.series.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveNifty500TurnoverSeries(data: Nifty500TurnoverSeries): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/** 12-month simple moving average on volume_kcr. */
export function movingAvgKcr(
  points: Array<{ month: string; volume_kcr: number }>,
  window = 12,
): Nifty500TurnoverPoint[] {
  const out: Nifty500TurnoverPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const slice = points.slice(Math.max(0, i - window + 1), i + 1);
    const ma =
      slice.length >= window
        ? slice.reduce((s, p) => s + p.volume_kcr, 0) / slice.length
        : slice.length >= 3
          ? slice.reduce((s, p) => s + p.volume_kcr, 0) / slice.length
          : null;
    out.push({
      month: points[i]!.month,
      volume_kcr: points[i]!.volume_kcr,
      ma_kcr: ma,
    });
  }
  return out;
}

/** Rupee turnover → ₹ crore. */
export function turnoverCr(close: number, volume: number): number {
  if (!Number.isFinite(close) || !Number.isFinite(volume)) return 0;
  return (close * volume) / 1e7;
}

/** ₹ crore → thousand crore (K cr) for chart axis. */
export function croreToKcr(cr: number): number {
  return cr / 1000;
}
