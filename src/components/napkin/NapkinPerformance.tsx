import type { NapkinPerformance as Perf } from "@/lib/napkin/performance";

export function NapkinPerformance({
  performance,
}: {
  performance?: Perf | null;
}) {
  if (!performance?.checks?.length) return null;
  return (
    <div className="napkin-sheet-section napkin-perf-block">
      <h2 className="napkin-block-title">
        Performance
        {performance.scored > 0 ? (
          <span className="napkin-perf-count">
            {" "}
            · {performance.passed}/{performance.scored}
          </span>
        ) : null}
      </h2>
      <ul className="napkin-perf-list">
        {performance.checks.map((c) => (
          <li
            key={c.id}
            className={`napkin-perf-row napkin-perf-row--${c.verdict}`}
          >
            <span className="napkin-perf-mark" aria-hidden>
              {c.verdict === "pass" ? "✓" : c.verdict === "fail" ? "✗" : "·"}
            </span>
            <span className="napkin-perf-label">
              {c.label} {c.threshold}
            </span>
            <span className="napkin-perf-value">{c.display}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
