"use client";

import type { NapkinQwenHit } from "@/lib/napkin/client";
import { formatNapkinPct } from "@/lib/napkin/format";
import { parseQwenBaseCagr, qwenSection } from "@/lib/napkin/qwen-sections";

export function NapkinScenarios({ qwen }: { qwen: NapkinQwenHit | null }) {
  if (!qwen || qwen.error) {
    return (
      <p className="napkin-pending">
        {qwen?.error || "Qwen has not run yet."}
      </p>
    );
  }
  const bear = qwenSection(qwen.sections, ["BEAR CASE"]);
  const base = qwenSection(qwen.sections, ["BASE CASE"]);
  const bull = qwenSection(qwen.sections, ["BULL CASE"]);
  const cells = [
    { title: "Bear", body: bear?.body, value: parseQwenBaseCagr(bear?.body) },
    { title: "Base", body: base?.body, value: parseQwenBaseCagr(base?.body) },
    { title: "Bull", body: bull?.body, value: parseQwenBaseCagr(bull?.body) },
  ];
  return (
    <div>
      <div className="napkin-scenario">
        {cells.map((c) => (
          <div key={c.title} className="napkin-scenario-box">
            <div className="napkin-scenario-title">{c.title}</div>
            <div className="napkin-scenario-value">{formatNapkinPct(c.value)}</div>
          </div>
        ))}
      </div>
      {base?.body ? <div className="napkin-evidence">{base.body}</div> : null}
    </div>
  );
}
