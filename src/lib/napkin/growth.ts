/**
 * Napkin Growth screen — thresholds are product rules, not issuer data.
 * Values are ratios (0.15 = 15%).
 */

import type { NapkinPerfCheck, NapkinPerformance, NapkinPerfVerdict } from "./performance";

export const NAPKIN_GROWTH = {
  revenueYoyMin: 0.15,
  patTtmMin: 0.5,
  epsYoyMin: 0.2,
  epsCagr3yMin: 0.15,
} as const;

function pctDisplay(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${(v * 100).toFixed(1)}%`;
}

function minCheck(value: number | null, min: number): NapkinPerfVerdict {
  if (value == null || !Number.isFinite(value)) return "na";
  return value >= min ? "pass" : "fail";
}

function finiteRatio(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v;
}

/** Latest vs prior annual point as a growth ratio. */
export function annualYoyGrowth(
  series: Array<{ value: number | null } | number | null> | null | undefined,
): number | null {
  if (!series?.length) return null;
  const nums: number[] = [];
  for (const item of series) {
    const v = typeof item === "number" ? item : item?.value ?? null;
    if (v != null && Number.isFinite(v)) nums.push(v);
  }
  if (nums.length < 2) return null;
  const latest = nums[nums.length - 1]!;
  const prior = nums[nums.length - 2]!;
  if (prior === 0) return null;
  return (latest - prior) / Math.abs(prior);
}

/**
 * PAT TTM growth from quarterly Net Profit (oldest → newest).
 * Needs 8 finite quarters: sum(last 4) vs sum(prior 4).
 */
export function patTtmGrowthFromQuarters(
  values: Array<number | null | undefined> | null | undefined,
): number | null {
  if (!values?.length) return null;
  const finite: number[] = [];
  for (const v of values) {
    if (v != null && Number.isFinite(v)) finite.push(v);
  }
  if (finite.length < 8) return null;
  const recent = finite.slice(-4).reduce((a, b) => a + b, 0);
  const prior = finite.slice(-8, -4).reduce((a, b) => a + b, 0);
  if (prior === 0) return null;
  return (recent - prior) / Math.abs(prior);
}

export function napkinGrowth(input: {
  revenue_yoy?: number | null;
  /** Prefer TTM from quarters; annual PAT YoY is the fallback. */
  pat_ttm?: number | null;
  pat_yoy?: number | null;
  eps_yoy?: number | null;
  eps_cagr_3y?: number | null;
}): NapkinPerformance {
  const rev = finiteRatio(input.revenue_yoy);
  const patTtm = finiteRatio(input.pat_ttm);
  const patYoy = finiteRatio(input.pat_yoy);
  const pat = patTtm ?? patYoy;
  const patIsTtm = patTtm != null;
  const epsY = finiteRatio(input.eps_yoy);
  const eps3 = finiteRatio(input.eps_cagr_3y);
  const checks: NapkinPerfCheck[] = [
    {
      id: "revenue_yoy",
      label: "Revenue growth YoY",
      threshold: `≥ ${(NAPKIN_GROWTH.revenueYoyMin * 100).toFixed(0)}%`,
      value: rev,
      display: pctDisplay(rev),
      verdict: minCheck(rev, NAPKIN_GROWTH.revenueYoyMin),
    },
    {
      id: patIsTtm ? "pat_ttm" : "pat_yoy",
      label: patIsTtm ? "PAT growth TTM" : "PAT growth YoY",
      threshold: `≥ ${(NAPKIN_GROWTH.patTtmMin * 100).toFixed(0)}%`,
      value: pat,
      display: pctDisplay(pat),
      verdict: minCheck(pat, NAPKIN_GROWTH.patTtmMin),
    },
    {
      id: "eps_yoy",
      label: "EPS growth YoY",
      threshold: `≥ ${(NAPKIN_GROWTH.epsYoyMin * 100).toFixed(0)}%`,
      value: epsY,
      display: pctDisplay(epsY),
      verdict: minCheck(epsY, NAPKIN_GROWTH.epsYoyMin),
    },
    {
      id: "eps_cagr_3y",
      label: "EPS growth 3Y",
      threshold: `≥ ${(NAPKIN_GROWTH.epsCagr3yMin * 100).toFixed(0)}%`,
      value: eps3,
      display: pctDisplay(eps3),
      verdict: minCheck(eps3, NAPKIN_GROWTH.epsCagr3yMin),
    },
  ];
  const scored = checks.filter((c) => c.verdict !== "na").length;
  const passed = checks.filter((c) => c.verdict === "pass").length;
  return { checks, passed, scored };
}
