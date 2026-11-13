import type { QuarterPanel, QuarterRow } from "@/lib/quarter-panel";

/** Sentinel for loss-making / >500 PE (shown as N/M, ranked worst). */
export const FORWARD_PE_NM = 999;

/**
 * Forward EPS run-rate (FinanciallyFree PEAD definition), oldest → newest:
 * latest quarter × 4; if that quarter is a loss, TTM when positive.
 * Otherwise null — never annualizes an old profitable quarter.
 * Checked against FF Result Monitor cards (Alembic 11.8 vs FF 11.9).
 */
export function forwardPeRunRate(epsValues: number[]): number | null {
  const eps = epsValues.filter((v) => v != null && Number.isFinite(v));
  if (!eps.length) return null;
  const latest = eps[eps.length - 1]!;
  if (latest > 0) return latest * 4;
  if (eps.length >= 4) {
    const ttm = eps.slice(-4).reduce((a, b) => a + b, 0);
    if (ttm > 0) return ttm;
  }
  return null;
}

/** PEAD2 forward PE: price ÷ forward EPS (see forwardPeRunRate). */
export function computeForwardPe(
  price: number | null | undefined,
  epsValues: number[],
): number | null {
  if (price == null || price <= 0) return null;
  const runRate = forwardPeRunRate(epsValues);
  if (runRate == null || runRate <= 0) return FORWARD_PE_NM;
  const pe = price / runRate;
  if (pe > 500) return FORWARD_PE_NM;
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

/** Trailing + forward PE and annualized EPS run-rate per quarter column (at current price). */
export function peRowsFromPanel(
  panel: QuarterPanel,
  price: number | null | undefined,
): QuarterRow[] {
  if (price == null || !Number.isFinite(price) || price <= 0) return [];
  const epsRow = panel.rows.find((r) => r.label === "EPS in Rs");
  if (!epsRow) return [];

  const eps = epsRow.values;
  // Same rule as the snapshot Fwd PE, using EPS available as of each column.
  const forwardPe = eps.map((e, i) => {
    if (e == null || !Number.isFinite(e)) return null;
    const upTo = eps
      .slice(0, i + 1)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const pe = computeForwardPe(price, upTo);
    if (pe == null || pe >= FORWARD_PE_NM) return null;
    return pe;
  });
  const trailingPe = eps.map((_, i) => {
    const slice = eps
      .slice(Math.max(0, i - 3), i + 1)
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

/** stocks-ai PEAD fpe coloring: lower is better. */
export function forwardPeClass(pe: number | null | undefined): string {
  if (pe == null || !Number.isFinite(pe)) return "fpe-na";
  if (pe >= 500) return "fpe-bad";
  if (pe > 40) return "fpe-bad";
  if (pe > 20) return "fpe-mid";
  return "fpe-good";
}
