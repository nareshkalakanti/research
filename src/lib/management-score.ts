/**
 * Management Score (0–5): +1 per shareholding check. Pure — no I/O.
 *
 * Color bands: 3–5 green · 1–2 yellow · 0 red.
 */
import { countScoreBand, type ScoreBand } from "./fundamental-score";

export type ManagementRuleId =
  | "shareholder_variation"
  | "pledged"
  | "holding_investor"
  | "promoter_3y"
  | "promoter_qoq";

export type ManagementRuleVerdict = "pass" | "fail" | "unknown";

export type ManagementRule = {
  id: ManagementRuleId;
  label: string;
  verdict: ManagementRuleVerdict;
  value: string | null;
  threshold: string;
};

export type ManagementScoreResult = {
  score: number;
  passed: number;
  evaluated: number;
  band: ScoreBand;
  rules: ManagementRule[];
};

export type ManagementScoreInput = {
  /** Shareholder counts, oldest → newest. */
  shareholder_counts?: Array<number | null> | null;
  /** Promoter pledge % of promoter holding (0 = none). */
  pledged_pct?: number | null;
  /** Latest FII holding %. */
  fii_pct?: number | null;
  /** Latest DII holding %. */
  dii_pct?: number | null;
  /** Promoter holding %, oldest → newest. */
  promoter_pct?: Array<number | null> | null;
};

function finite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

function lastTwoFinite(
  values: Array<number | null> | null | undefined,
): [number | null, number | null] {
  if (!values?.length) return [null, null];
  let end: number | null = null;
  let prior: number | null = null;
  for (let i = values.length - 1; i >= 0; i--) {
    if (!finite(values[i])) continue;
    if (end == null) end = values[i]!;
    else {
      prior = values[i]!;
      break;
    }
  }
  return [end, prior];
}

/** Promoter % ~3 years earlier vs latest (prefer ~12 quarterly steps back). */
function promoterDelta3y(
  values: Array<number | null> | null | undefined,
): number | null {
  if (!values?.length) return null;
  let endIdx = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    if (finite(values[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return null;
  const targetBack = Math.min(12, endIdx);
  let startIdx = -1;
  for (let i = endIdx - targetBack; i >= 0; i--) {
    if (finite(values[i])) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0 || startIdx === endIdx) return null;
  return values[endIdx]! - values[startIdx]!;
}

function fmtPp(v: number | null): string | null {
  if (!finite(v)) return null;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)} pp`;
}

function fmtPct(v: number | null): string | null {
  if (!finite(v)) return null;
  return `${v.toFixed(2)}%`;
}

export function managementScore(
  input: ManagementScoreInput,
): ManagementScoreResult {
  const rules: ManagementRule[] = [];

  {
    const [latest, prior] = lastTwoFinite(input.shareholder_counts);
    let verdict: ManagementRuleVerdict = "unknown";
    let value: string | null = null;
    if (finite(latest) && finite(prior) && prior > 0) {
      const delta = latest - prior;
      value = `${prior.toLocaleString("en-IN")} → ${latest.toLocaleString("en-IN")}`;
      verdict = delta < 0 ? "pass" : "fail";
    }
    rules.push({
      id: "shareholder_variation",
      label: "Shareholder Variation",
      verdict,
      value,
      threshold: "QoQ # shareholders ↓",
    });
  }

  {
    const pledge = finite(input.pledged_pct) ? input.pledged_pct : null;
    let verdict: ManagementRuleVerdict = "unknown";
    if (finite(pledge)) verdict = pledge <= 0 ? "pass" : "fail";
    rules.push({
      id: "pledged",
      label: "Pledged Percentage",
      verdict,
      value: fmtPct(pledge),
      threshold: "= 0%",
    });
  }

  {
    const fii = finite(input.fii_pct) ? input.fii_pct : null;
    const dii = finite(input.dii_pct) ? input.dii_pct : null;
    let verdict: ManagementRuleVerdict = "unknown";
    let value: string | null = null;
    // Meaningful institutional stake (token sub-1% holdings do not count).
    const INST_MIN = 1;
    if (fii != null || dii != null) {
      const f = fii ?? 0;
      const d = dii ?? 0;
      const total = f + d;
      value = `FII ${f.toFixed(2)}% · DII ${d.toFixed(2)}%`;
      verdict = total >= INST_MIN ? "pass" : "fail";
    }
    rules.push({
      id: "holding_investor",
      label: "Holding Investor",
      verdict,
      value,
      threshold: `FII+DII ≥ ${INST_MIN}%`,
    });
  }

  {
    const delta = promoterDelta3y(input.promoter_pct);
    let verdict: ManagementRuleVerdict = "unknown";
    if (finite(delta)) verdict = delta > 0 ? "pass" : "fail";
    rules.push({
      id: "promoter_3y",
      label: "Change in Promoter Holding (3Y)",
      verdict,
      value: fmtPp(delta),
      threshold: "promoter % ↑",
    });
  }

  {
    // Pass if promoter % rose in either of the last two QoQ steps (recent window).
    const vals = input.promoter_pct ?? [];
    const finiteIdx: number[] = [];
    for (let i = vals.length - 1; i >= 0 && finiteIdx.length < 3; i--) {
      if (finite(vals[i])) finiteIdx.push(i);
    }
    finiteIdx.reverse();
    let delta: number | null = null;
    let verdict: ManagementRuleVerdict = "unknown";
    if (finiteIdx.length >= 2) {
      const latest = vals[finiteIdx[finiteIdx.length - 1]!]!;
      const prior = vals[finiteIdx[finiteIdx.length - 2]!]!;
      delta = latest - prior;
      let rose = delta > 0;
      if (finiteIdx.length >= 3) {
        const mid = vals[finiteIdx[finiteIdx.length - 2]!]!;
        const older = vals[finiteIdx[finiteIdx.length - 3]!]!;
        if (mid - older > 0) rose = true;
      }
      verdict = rose ? "pass" : "fail";
    }
    rules.push({
      id: "promoter_qoq",
      label: "Change in Promoter Holding (Quarterly)",
      verdict,
      value: fmtPp(delta),
      threshold: "promoter % ↑ in last 2Q",
    });
  }

  const passed = rules.filter((r) => r.verdict === "pass").length;
  const evaluated = rules.filter((r) => r.verdict !== "unknown").length;

  return {
    score: passed,
    passed,
    evaluated,
    band: countScoreBand(passed),
    rules,
  };
}
