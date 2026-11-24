import type { QuarterPanel, QuarterRow } from "@/lib/quarter-panel";

/** Sentinel for loss-making / >500 PE (shown as N/M, ranked worst). */
export const FORWARD_PE_NM = 999;

export type PeriodsPerYear = 2 | 4;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 2025" → months since year 0, or null. */
function labelMonthIndex(label: string): number | null {
  const m = /^([A-Z][a-z]{2})\s+(\d{4})$/.exec(label.trim());
  if (!m) return null;
  const mon = MONTH_NAMES.indexOf(m[1]!);
  return mon < 0 ? null : Number(m[2]) * 12 + mon;
}

/**
 * Results per year from the panel's period labels, oldest → newest: 2 when
 * the latest filings are 6 months apart (half-yearly SME filers), else 4.
 * Same rule as `trailingYear` in ttm.ts: four 3-month steps = quarterly;
 * the last filings 6 months apart = half-yearly.
 */
export function epsPeriodsPerYear(labels: readonly string[]): PeriodsPerYear {
  const idx = labels.map(labelMonthIndex).filter((x): x is number => x != null);
  const steps = (ys: number[], gap: number) => ys.every((y, i) => i === 0 || Math.abs(y - ys[i - 1]! - gap) <= 1);
  const q = idx.slice(-4);
  if (q.length === 4 && steps(q, 3)) return 4;
  const h = idx.slice(-3);
  if (h.length >= 2 && steps(h, 6)) return 2;
  return 4;
}

/**
 * Forward EPS run-rate, oldest → newest: latest period × periods per year
 * (× 4 quarterly, × 2 half-yearly); if that period is a loss, the trailing
 * year when positive. Otherwise null — never annualizes an old profitable period.
 */
export function forwardPeRunRate(epsValues: number[], perYear: PeriodsPerYear = 4): number | null {
  const eps = epsValues.filter((v) => v != null && Number.isFinite(v));
  if (!eps.length) return null;
  const latest = eps[eps.length - 1]!;
  if (latest > 0) return latest * perYear;
  if (eps.length >= perYear) {
    const ttm = eps.slice(-perYear).reduce((a, b) => a + b, 0);
    if (ttm > 0) return ttm;
  }
  return null;
}

/** Forward PE: price ÷ forward EPS (see forwardPeRunRate). */
export function computeForwardPe(
  price: number | null | undefined,
  epsValues: number[],
  perYear: PeriodsPerYear = 4,
): number | null {
  if (price == null || price <= 0) return null;
  const runRate = forwardPeRunRate(epsValues, perYear);
  if (runRate == null || runRate <= 0) return FORWARD_PE_NM;
  const pe = price / runRate;
  if (pe > 500) return FORWARD_PE_NM;
  return Math.round(pe * 10) / 10;
}

/** Trailing PE from the last year of EPS: 4 quarters, or 2 half-years. */
export function computeTrailingPe(
  price: number | null | undefined,
  epsValues: number[],
  perYear: PeriodsPerYear = 4,
): number | null {
  if (price == null || price <= 0) return null;
  const eps = epsValues.filter((v) => v != null && Number.isFinite(v));
  if (!eps.length) return null;
  const ttm =
    eps.length >= perYear
      ? eps.slice(-perYear).reduce((a, b) => a + b, 0)
      : eps.reduce((a, b) => a + b, 0);
  if (ttm === 0) return null;
  return Math.round((price / ttm) * 10) / 10;
}

export function epsFromQuarterPanel(panel: QuarterPanel): number[] {
  const row = panel.rows.find((r) => r.label === "EPS in Rs");
  if (!row) return [];
  return row.values.filter((v): v is number => v != null && Number.isFinite(v));
}

/** Forward PE for a quarter panel, half-yearly aware. */
export function forwardPeFromPanel(price: number | null | undefined, panel: QuarterPanel): number | null {
  return computeForwardPe(price, epsFromQuarterPanel(panel), epsPeriodsPerYear(panel.labels));
}

/** Trailing + forward PE and annualized EPS run-rate per quarter column (at current price). */
export function peRowsFromPanel(
  panel: QuarterPanel,
  price: number | null | undefined,
): QuarterRow[] {
  if (price == null || !Number.isFinite(price) || price <= 0) return [];
  const epsRow = panel.rows.find((r) => r.label === "EPS in Rs");
  if (!epsRow) return [];

  const eps = epsRow.values;
  // Half-yearly vs quarterly as of each column (a filer can switch).
  const perYearAt = panel.labels.map((_, i) => epsPeriodsPerYear(panel.labels.slice(0, i + 1)));
  // Same rule as the snapshot Fwd PE, using EPS available as of each column.
  const forwardPe = eps.map((e, i) => {
    if (e == null || !Number.isFinite(e)) return null;
    const upTo = eps
      .slice(0, i + 1)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const pe = computeForwardPe(price, upTo, perYearAt[i]!);
    if (pe == null || pe >= FORWARD_PE_NM) return null;
    return pe;
  });
  const trailingPe = eps.map((_, i) => {
    const slice = eps
      .slice(Math.max(0, i - (perYearAt[i]! - 1)), i + 1)
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (!slice.length) return null;
    const ttm = slice.reduce((a, b) => a + b, 0);
    if (ttm <= 0) return null;
    const pe = price / ttm;
    if (pe > 500) return null;
    return Math.round(pe * 100) / 100;
  });

  return [
    { label: "Current PE", values: trailingPe, good_up: false, decimals: 2 },
    { label: "Forward PE", values: forwardPe, good_up: false, decimals: 2 },
  ];
}

export function formatPeDisplay(pe: number | null | undefined): string {
  if (pe == null || !Number.isFinite(pe)) return "—";
  if (pe >= 500) return "N/M";
  return pe.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

/** Fwd PE colouring: lower is better. */
export function forwardPeClass(pe: number | null | undefined): string {
  if (pe == null || !Number.isFinite(pe)) return "fpe-na";
  if (pe >= 500) return "fpe-bad";
  if (pe > 40) return "fpe-bad";
  if (pe > 20) return "fpe-mid";
  return "fpe-good";
}
