import type { Bar } from "./indicators";
import { computeDriftPct } from "./strategy/concall-drift-math";

export type DailyDriftPoint = {
  date: string;
  close: number;
  pct_from_baseline: number | null;
  pct_from_prior: number | null;
  volume: number;
};

/** Trading days on/after concall (or earn) with % vs pre-earn baseline. */
export function buildDailyDriftPath(
  bars: Bar[],
  anchorAt: string,
  baseline: number | null,
  maxDays = 12,
): DailyDriftPoint[] {
  if (!baseline || baseline <= 0) return [];
  const anchorDay = anchorAt.slice(0, 10);
  const path: DailyDriftPoint[] = [];
  let prevClose: number | null = null;

  for (const bar of bars) {
    if (bar.date.slice(0, 10) < anchorDay) continue;
    if (path.length >= maxDays) break;
    const pctPrior =
      prevClose != null && prevClose > 0
        ? computeDriftPct(bar.close, prevClose)
        : null;
    path.push({
      date: bar.date.slice(0, 10),
      close: bar.close,
      pct_from_baseline: computeDriftPct(bar.close, baseline),
      pct_from_prior: pctPrior,
      volume: bar.volume,
    });
    prevClose = bar.close;
  }
  return path;
}

export function formatDailyPathForPrompt(path: DailyDriftPoint[]): string {
  if (!path.length) return "No daily OHLC after event anchor.";
  return path
    .map((p, i) => {
      const base =
        p.pct_from_baseline != null
          ? `${p.pct_from_baseline >= 0 ? "+" : ""}${p.pct_from_baseline.toFixed(1)}% vs baseline`
          : "—";
      const day =
        i > 0 && p.pct_from_prior != null
          ? `, ${p.pct_from_prior >= 0 ? "+" : ""}${p.pct_from_prior.toFixed(1)}% vs prior session`
          : "";
      const vol = p.volume > 0 ? `, vol ${Math.round(p.volume).toLocaleString("en-IN")}` : "";
      return `  ${p.date}: ₹${p.close.toFixed(2)} (${base}${day}${vol})`;
    })
    .join("\n");
}
