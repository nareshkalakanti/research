import type { EvidenceBundle, EvaluationResult } from "./types";

/** Collect numeric literals traceable to evidence JSON. */
export function evidenceNumbers(e: EvidenceBundle): Set<number> {
  const out = new Set<number>();
  function walk(v: unknown) {
    if (v == null) return;
    if (typeof v === "number" && Number.isFinite(v)) {
      out.add(v);
      out.add(Math.round(v));
      out.add(Math.round(v * 10) / 10);
      out.add(Math.round(v * 100) / 100);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  }
  walk(e);
  return out;
}

const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

export function verifyEvaluation(
  evidence: EvidenceBundle,
  result: EvaluationResult,
): string[] {
  const allowed = evidenceNumbers(evidence);
  const warnings: string[] = [];
  const text = JSON.stringify(result.scores) + JSON.stringify(result.verdict);

  for (const m of text.match(NUMBER_RE) ?? []) {
    const n = Number(m);
    if (!Number.isFinite(n)) continue;
    if (n >= 0 && n <= 100 && Number.isInteger(n)) {
      /* scores — ok */
      continue;
    }
    if (n >= 1 && n <= 10 && Number.isInteger(n)) {
      /* confidence */
      continue;
    }
    const rounded = [
      n,
      Math.round(n * 10) / 10,
      Math.round(n * 100) / 100,
      Math.round(n),
    ];
    if (rounded.some((r) => allowed.has(r))) continue;
    if (Math.abs(n) <= 2 && Number.isInteger(n)) continue; /* small deltas */
    warnings.push(`Untraceable figure: ${m}`);
  }

  return [...new Set(warnings)].slice(0, 5);
}
