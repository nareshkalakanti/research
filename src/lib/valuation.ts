import type { QuarterPanel } from "@/lib/quarter-panel";

/** Ignore tiny EPS blips when falling back from a loss quarter. */
const MATERIAL_EPS = 0.05;

/**
 * Annualized EPS for forward PE: latest quarter × 4, else TTM, else last
 * material positive quarter (handles one-off loss quarters like BPL).
 */
export function forwardPeRunRate(epsValues: number[]): number | null {
  const eps = epsValues.filter((v) => v != null && Number.isFinite(v));
  if (!eps.length) return null;

  const latestRate = eps[eps.length - 1]! * 4;
  if (latestRate > 0) return latestRate;

  if (eps.length >= 4) {
    const ttm = eps.slice(-4).reduce((a, b) => a + b, 0);
    if (ttm > 0) return ttm;
  }

  for (let i = eps.length - 1; i >= 0; i--) {
    const e = eps[i]!;
    if (e >= MATERIAL_EPS) return e * 4;
  }
  return null;
}

/** PEAD2 run-rate forward PE: price ÷ annualized EPS (see forwardPeRunRate). */
export function computeForwardPe(
  price: number | null | undefined,
  epsValues: number[],
): number | null {
  if (price == null || price <= 0) return null;
  const runRate = forwardPeRunRate(epsValues);
  if (runRate == null || runRate <= 0) return 999;
  const pe = price / runRate;
  if (pe > 500) return 999;
  return Math.round(pe * 10) / 10;
}

/** Trailing PE from last four quarterly EPS (TTM). */
export function computeTrailingPe(
  price: number | null | undefined,
  epsValues: number[],
): number | null {
  if (price == null || price <= 0) return null;
  const eps = epsValues.filter((v) => v != null && Number.isFinite(v));
  if (!eps.length) return null;
  const ttm =
    eps.length >= 4
      ? eps.slice(-4).reduce((a, b) => a + b, 0)
      : eps.reduce((a, b) => a + b, 0);
  if (ttm === 0) return null;
  return Math.round((price / ttm) * 10) / 10;
}

export function epsFromQuarterPanel(panel: QuarterPanel): number[] {
  const row = panel.rows.find((r) => r.label === "EPS in Rs");
  if (!row) return [];
  return row.values.filter((v): v is number => v != null && Number.isFinite(v));
}

export function formatPeDisplay(pe: number | null | undefined): string {
  if (pe == null || !Number.isFinite(pe)) return "—";
  if (pe >= 500) return "N/M";
  return pe.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

/** stocks-ai PEAD fpe coloring: lower is better. */
export function forwardPeClass(pe: number | null | undefined): string {
  if (pe == null || !Number.isFinite(pe)) return "fpe-na";
  if (pe >= 500) return "fpe-bad";
  if (pe > 40) return "fpe-bad";
  if (pe > 20) return "fpe-mid";
  return "fpe-good";
}
