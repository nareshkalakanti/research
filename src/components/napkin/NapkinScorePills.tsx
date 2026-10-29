"use client";

import type { NapkinEvalPayload } from "@/lib/napkin/types";

export function NapkinScorePills({
  evalScores,
}: {
  evalScores?: NapkinEvalPayload | null;
}) {
  if (!evalScores?.pills?.length) return null;
  return (
    <div className="napkin-sheet-section napkin-score-pills-block">
      <h2 className="napkin-block-title">Scores</h2>
      <div className="napkin-score-pills" role="list">
        {evalScores.pills.map((p) => (
          <div key={p.key} className="napkin-score-pill-wrap" role="listitem">
            <span className="napkin-score-pill-label">{p.label}</span>
            <span className={`napkin-score-pill napkin-score-pill--${p.band}`}>
              {p.display ?? p.score}
            </span>
          </div>
        ))}
        <div className="napkin-score-pill-wrap" role="listitem">
          <span className="napkin-score-pill-label">Rating</span>
          <span
            className={`napkin-score-pill napkin-score-pill--${
              evalScores.final_rating === "Good"
                ? "green"
                : evalScores.final_rating === "Average"
                  ? "yellow"
                  : "red"
            } napkin-score-pill--text`}
          >
            {evalScores.final_rating}
          </span>
        </div>
      </div>
    </div>
  );
}
