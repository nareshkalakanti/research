"use client";

import type { NapkinStepEvent, NapkinStepId, NapkinStepStatus } from "@/lib/napkin/progress";
import { NAPKIN_FLOW_STEPS } from "@/lib/napkin/progress";

const ORDER: NapkinStepId[] = NAPKIN_FLOW_STEPS.map((s) => s.id);

export function NapkinProgress({
  steps,
}: {
  steps: Partial<Record<NapkinStepId, NapkinStepEvent>>;
}) {
  return (
    <ol className="napkin-progress">
      {NAPKIN_FLOW_STEPS.map((def) => {
        const ev = steps[def.id];
        const status: NapkinStepStatus = ev?.status ?? "pending";
        const extra = [ev?.detail, ev?.ms != null ? `${ev.ms}ms` : null]
          .filter(Boolean)
          .join(" · ");
        return (
          <li key={def.id} className={`napkin-progress-row is-${status}`}>
            <span className="napkin-progress-mark">{mark(status)}</span>
            <span className="napkin-progress-label">{def.label}</span>
            {extra ? <span className="napkin-progress-detail">{extra}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function mark(status: NapkinStepStatus): string {
  if (status === "running") return "…";
  if (status === "done") return "✓";
  if (status === "fail") return "×";
  if (status === "skip") return "–";
  return "○";
}

export function applyStep(
  prev: Partial<Record<NapkinStepId, NapkinStepEvent>>,
  ev: NapkinStepEvent,
): Partial<Record<NapkinStepId, NapkinStepEvent>> {
  return { ...prev, [ev.id]: ev };
}

export { ORDER };
