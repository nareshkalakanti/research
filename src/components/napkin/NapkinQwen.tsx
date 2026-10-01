"use client";

import type { NapkinQwenHit } from "@/lib/napkin/client";
import { groupQwenSections } from "@/lib/napkin/qwen-sections";

export function NapkinQwen({
  qwen,
  groupTitle,
}: {
  qwen: NapkinQwenHit | null;
  groupTitle?: string;
}) {
  if (!qwen) {
    return <p className="napkin-pending">Qwen has not run yet.</p>;
  }
  if (qwen.error) {
    return <p className="napkin-error">{qwen.error}</p>;
  }
  if (!qwen.sections.length) {
    return <p className="napkin-pending">Qwen returned no sections.</p>;
  }
  const groups = groupQwenSections(qwen.sections).filter((g) =>
    groupTitle ? g.title === groupTitle : true,
  );
  if (!groups.length) {
    return <p className="napkin-pending">Not available</p>;
  }
  return (
    <div className="napkin-qwen">
      {qwen.model && !groupTitle ? (
        <p className="napkin-eyebrow">{qwen.model}</p>
      ) : null}
      {groups.map((g) => (
        <div key={g.title} className="napkin-qwen-group">
          {!groupTitle ? <h3 className="napkin-qwen-group-title">{g.title}</h3> : null}
          {g.items.map((s) => (
            <article key={s.heading} className="napkin-qwen-block">
              <h4>{s.heading}</h4>
              <div className="napkin-evidence">{s.body}</div>
            </article>
          ))}
        </div>
      ))}
    </div>
  );
}
