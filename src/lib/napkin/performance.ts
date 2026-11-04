/**
 * Simple Napkin performance screen — thresholds are product rules, not issuer data.
 * Values are ratios (0.20 = 20%) except where noted.
 */

export const NAPKIN_PERF = {
  revenueCagrMin: 0.2,
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

/** Prefer 5Y revenue CAGR; else 3Y; else 2Y. Threshold stays >20%. */
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

export function napkinPerformance(input: {
  revenue_cagr_5y?: number | null;
  revenue_cagr_3y?: number | null;
  revenue_cagr_2y?: number | null;
  ebitda_margin?: number | null;
  roce?: number | null;
  debt_equity?: number | null;
}): NapkinPerformance {
  const rev = pickRevenueCagr(
    input.revenue_cagr_5y,
    input.revenue_cagr_3y,
    input.revenue_cagr_2y,
  );
  const checks: NapkinPerfCheck[] = [
    {
      id: "revenue_cagr",
      label: rev.label,
      threshold: `> ${(NAPKIN_PERF.revenueCagrMin * 100).toFixed(0)}%`,
      value: rev.value,
      display: pctDisplay(rev.value),
      verdict: minCheck(rev.value, NAPKIN_PERF.revenueCagrMin),
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
