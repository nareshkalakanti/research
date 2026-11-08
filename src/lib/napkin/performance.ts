/**
 * Simple Napkin performance screen — thresholds are product rules, not issuer data.
 * Values are ratios (0.15 = 15%) except where noted.
 */

export const NAPKIN_PERF = {
  /** Pass when 5Y or 3Y revenue CAGR clears this (OR). */
  revenueCagrMin: 0.15,
  ebitdaMarginMin: 0.15,
  roceMin: 0.18,
  debtEquityMax: 0.5,
} as const;

export type NapkinPerfVerdict = "pass" | "fail" | "na";

export type NapkinPerfCheck = {
  id: "revenue_cagr" | "ebitda_margin" | "roce" | "debt_equity";
  label: string;
  threshold: string;
  value: number | null;
  display: string;
  verdict: NapkinPerfVerdict;
};

export type NapkinPerformance = {
  checks: NapkinPerfCheck[];
  passed: number;
  scored: number;
};

function pctDisplay(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${(v * 100).toFixed(1)}%`;
}

function xDisplay(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${v.toFixed(2)}x`;
}

function minCheck(
  value: number | null,
  min: number,
): NapkinPerfVerdict {
  if (value == null || !Number.isFinite(value)) return "na";
  return value >= min ? "pass" : "fail";
}

function maxCheck(
  value: number | null,
  max: number,
): NapkinPerfVerdict {
  if (value == null || !Number.isFinite(value)) return "na";
  return value <= max ? "pass" : "fail";
}

/** Prefer 5Y revenue CAGR for display; else 3Y; else 2Y. */
export function pickRevenueCagr(
  cagr5y: number | null | undefined,
  cagr3y: number | null | undefined,
  cagr2y?: number | null | undefined,
): { value: number | null; label: string } {
  if (cagr5y != null && Number.isFinite(cagr5y)) {
    return { value: cagr5y, label: "Revenue CAGR 5Y" };
  }
  if (cagr3y != null && Number.isFinite(cagr3y)) {
    return { value: cagr3y, label: "Revenue CAGR 3Y" };
  }
  if (cagr2y != null && Number.isFinite(cagr2y)) {
    return { value: cagr2y, label: "Revenue CAGR 2Y" };
  }
  return { value: null, label: "Revenue CAGR" };
}

function finiteRatio(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v;
}

/** Pass if 5Y > min OR 3Y > min; else fall back to 2Y alone. */
export function scoreRevenueCagr(
  cagr5y: number | null | undefined,
  cagr3y: number | null | undefined,
  cagr2y?: number | null | undefined,
): {
  value: number | null;
  label: string;
  verdict: NapkinPerfVerdict;
  threshold: string;
} {
  const min = NAPKIN_PERF.revenueCagrMin;
  const pct = (min * 100).toFixed(0);
  const threshold = `> ${pct}% (5Y or 3Y)`;
  const c5 = finiteRatio(cagr5y);
  const c3 = finiteRatio(cagr3y);
  const c2 = finiteRatio(cagr2y);
  const pass5 = c5 != null && c5 >= min;
  const pass3 = c3 != null && c3 >= min;

  if (pass5 || pass3) {
    // Prefer the passing window; if both pass, show 5Y.
    if (pass5) {
      return {
        value: c5,
        label: "Revenue CAGR 5Y",
        verdict: "pass",
        threshold,
      };
    }
    return {
      value: c3,
      label: "Revenue CAGR 3Y",
      verdict: "pass",
      threshold,
    };
  }

  if (c5 != null || c3 != null) {
    const rev = pickRevenueCagr(c5, c3, null);
    return {
      value: rev.value,
      label: rev.label,
      verdict: "fail",
      threshold,
    };
  }

  if (c2 != null) {
    return {
      value: c2,
      label: "Revenue CAGR 2Y",
      verdict: minCheck(c2, min),
      threshold: `> ${pct}%`,
    };
  }

  return {
    value: null,
    label: "Revenue CAGR",
    verdict: "na",
    threshold,
  };
}

export function napkinPerformance(input: {
  revenue_cagr_5y?: number | null;
  revenue_cagr_3y?: number | null;
  revenue_cagr_2y?: number | null;
  ebitda_margin?: number | null;
  roce?: number | null;
  debt_equity?: number | null;
}): NapkinPerformance {
  const rev = scoreRevenueCagr(
    input.revenue_cagr_5y,
    input.revenue_cagr_3y,
    input.revenue_cagr_2y,
  );
  const checks: NapkinPerfCheck[] = [
    {
      id: "revenue_cagr",
      label: rev.label,
      threshold: rev.threshold,
      value: rev.value,
      display: pctDisplay(rev.value),
      verdict: rev.verdict,
    },
    {
      id: "ebitda_margin",
      label: "EBITDA margin",
      threshold: `> ${(NAPKIN_PERF.ebitdaMarginMin * 100).toFixed(0)}%`,
      value: input.ebitda_margin ?? null,
      display: pctDisplay(input.ebitda_margin ?? null),
      verdict: minCheck(input.ebitda_margin ?? null, NAPKIN_PERF.ebitdaMarginMin),
    },
    {
      id: "roce",
      label: "ROCE",
      threshold: `> ${(NAPKIN_PERF.roceMin * 100).toFixed(0)}%`,
      value: input.roce ?? null,
      display: pctDisplay(input.roce ?? null),
      verdict: minCheck(input.roce ?? null, NAPKIN_PERF.roceMin),
    },
    {
      id: "debt_equity",
      label: "Debt / Equity",
      threshold: `< ${NAPKIN_PERF.debtEquityMax}`,
      value: input.debt_equity ?? null,
      display: xDisplay(input.debt_equity ?? null),
      verdict: maxCheck(input.debt_equity ?? null, NAPKIN_PERF.debtEquityMax),
    },
  ];
  const scored = checks.filter((c) => c.verdict !== "na").length;
  const passed = checks.filter((c) => c.verdict === "pass").length;
  return { checks, passed, scored };
}
