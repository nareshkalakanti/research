import type {
  NapkinPerfCheck,
  NapkinPerformance as Perf,
  NapkinPerfVerdict,
} from "@/lib/napkin/performance";

function ratingFromChecks(passed: number, scored: number): {
  label: string;
  cls: string;
} | null {
  if (scored <= 0) return null;
  if (passed === scored) {
    return { label: "Pass", cls: "seven-rule-rating--buy" };
  }
  if (passed >= Math.ceil(scored * 0.75)) {
    return { label: "Mixed", cls: "seven-rule-rating--hold" };
  }
  return { label: "Weak", cls: "seven-rule-rating--sell" };
}

function ruleClass(verdict: NapkinPerfVerdict): string {
  if (verdict === "pass") return "seven-rule-rule--pass";
  if (verdict === "fail") return "seven-rule-rule--fail";
  return "seven-rule-rule--unknown";
}

function verdictLabel(verdict: NapkinPerfVerdict): string {
  if (verdict === "pass") return "Pass";
  if (verdict === "fail") return "Fail";
  return "N/A";
}

function CheckRow({ check }: { check: NapkinPerfCheck }) {
  return (
    <li className={`seven-rule-rule ${ruleClass(check.verdict)}`}>
      <span className="seven-rule-rule-label">
        {check.label} {check.threshold}
      </span>
      <span className="seven-rule-rule-val">{check.display}</span>
      <span className="seven-rule-rule-verdict">
        {verdictLabel(check.verdict)}
      </span>
    </li>
  );
}

export function NapkinPerformance({
  performance,
}: {
  performance?: Perf | null;
}) {
  if (!performance?.checks?.length) return null;
  const { checks, passed, scored } = performance;
  const denom = scored > 0 ? scored : checks.length;
  const score =
    denom > 0 ? Math.round((passed / denom) * 1000) / 100 : 0;
  const pct = Math.min(100, Math.max(0, (score / 10) * 100));
  const rating = ratingFromChecks(passed, denom);

  return (
    <div className="napkin-sheet-section napkin-perf-block">
      <div className="seven-rule-card napkin-perf-card">
        <div className="seven-rule-head">
          <div className="seven-rule-score-line">
            <span className="seven-rule-score-num">{score.toFixed(2)}</span>
            <span className="seven-rule-score-denom">/10</span>
            {rating ? (
              <span className={`seven-rule-rating ${rating.cls}`}>
                {rating.label}
              </span>
            ) : null}
          </div>
          <div className="seven-rule-bar" aria-hidden>
            <div
              className={`seven-rule-bar-fill ${rating?.cls ?? ""}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="seven-rule-sub">
            {passed} of {denom} checks passed
          </p>
        </div>
        <ul className="seven-rule-rules">
          {checks.map((c) => (
            <CheckRow key={c.id} check={c} />
          ))}
        </ul>
      </div>
    </div>
  );
}
