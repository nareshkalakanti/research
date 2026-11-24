import type { QuarterPanel } from "./quarter-panel";
import { epsPeriodsPerYear } from "./valuation";

/**
 * Sanity checks shown with a quarterly chart. A chart is still drawn when a
 * check fails, but with a warning and no YoY figures (they would be wrong).
 *   mismatch — last-12-months sales outside 0.5–2× the annual report (₹5 Cr+),
 *              or 100×+ off at any size
 *   breaks   — sales jump or drop more than 50× between consecutive periods
 *              (another company's quarters, or units mixed up)
 *   stale    — latest result more than ~10 months old
 */
export type QuarterChecks = {
  annual_ratio: number | null;
  mismatch: boolean;
  breaks: boolean;
  stale: boolean;
  latest: string | null;
  warning: string | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function labelEnd(label: string): number | null {
  const m = /^([A-Z][a-z]{2})\s+(\d{4})$/.exec(label.trim());
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1]!);
  return mon < 0 ? null : Date.UTC(Number(m[2]), mon + 1, 0);
}

export function quarterChecks(
  panel: QuarterPanel | null,
  annualSales: Array<number | null> | null | undefined,
  now = Date.now(),
): QuarterChecks {
  const empty: QuarterChecks = { annual_ratio: null, mismatch: false, breaks: false, stale: false, latest: null, warning: null };
  if (!panel?.labels.length) return empty;
  const sales = panel.rows.find((r) => r.label === "Sales")?.values ?? [];
  const latest = panel.labels[panel.labels.length - 1] ?? null;
  const end = latest ? labelEnd(latest) : null;
  const stale = end != null && now - end > 300 * 86_400_000;

  let breaks = false;
  let prev: number | null = null;
  for (const v of sales) {
    if (v == null || v <= 0) continue;
    if (prev != null && (v / prev > 50 || prev / v > 50)) breaks = true;
    prev = v;
  }

  const perYear = epsPeriodsPerYear(panel.labels);
  const tail = sales.slice(-perYear);
  const ttm = tail.length === perYear && tail.every((v) => v != null) ? tail.reduce<number>((a, v) => a + (v as number), 0) : null;
  const annual = [...(annualSales ?? [])].reverse().find((v) => v != null && v > 0) ?? null;
  const ratio = ttm != null && annual ? Math.round((ttm / annual) * 1000) / 1000 : null;
  // Small companies: only a gap of 100×+ counts (units mixed up), not ordinary swings.
  const mismatch = ratio != null && ((annual! >= 5 && (ratio < 0.5 || ratio > 2)) || ratio > 100 || ratio < 0.01);

  const warning = breaks
    ? "Sales jump more than 50× between periods: part of this series may be another company's or in other units."
    : mismatch
      ? `Quarterly sales don't match the annual report (last 12 months ${ratio}× the latest annual sales).`
      : stale
        ? `Latest result is ${latest}, over 10 months old.`
        : null;
  return { annual_ratio: ratio, mismatch, breaks, stale, latest, warning };
}
