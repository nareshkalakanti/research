"use client";

import { useState } from "react";
import type { SevenRuleResult, SevenRuleRule } from "@/lib/seven-rule-score";

function ratingClass(rating: SevenRuleResult["rating"]): string {
  if (rating === "strong_buy" || rating === "buy") return "seven-rule-rating--buy";
  if (rating === "deep_dive") return "seven-rule-rating--hold";
  return "seven-rule-rating--sell";
}

function ruleClass(verdict: SevenRuleRule["verdict"]): string {
  if (verdict === "pass") return "seven-rule-rule--pass";
  if (verdict === "fail") return "seven-rule-rule--fail";
  return "seven-rule-rule--unknown";
}

function verdictLabel(verdict: SevenRuleRule["verdict"]): string {
  if (verdict === "pass") return "Pass";
  if (verdict === "fail") return "Fail";
  return "Unknown";
}

type Props = {
  result: SevenRuleResult;
  /** Start collapsed with a Show toggle (Quarters / Quality rhythm). */
  compact?: boolean;
  /** Override initial expand when compact. */
  defaultExpanded?: boolean;
};

export function SevenRuleScoreCard({
  result,
  compact,
  defaultExpanded = false,
}: Props) {
  const [expanded, setExpanded] = useState(
    compact ? defaultExpanded : true,
  );
  const pct = Math.min(100, Math.max(0, (result.score / 10) * 100));
  const barClass = ratingClass(result.rating);
  const showRules = !compact || expanded;

  return (
    <div
      className={`seven-rule-card${
        compact && !expanded ? " seven-rule-card--compact" : ""
      }`}
    >
      <div className="seven-rule-head">
        <div className="seven-rule-score-line">
          <span className="seven-rule-score-num">{result.score.toFixed(2)}</span>
          <span className="seven-rule-score-denom">/10</span>
          {result.ratingLabel ? (
            <span
              className={`seven-rule-rating ${ratingClass(result.rating)}`}
              title={
                result.provisional
                  ? "Incomplete inputs — rating from rules evaluated so far"
                  : undefined
              }
            >
              {result.ratingLabel}
            </span>
          ) : null}
        </div>
        <div className="seven-rule-bar" aria-hidden>
          <div
            className={`seven-rule-bar-fill ${barClass}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="seven-rule-sub">
          {result.passed} of 7 rules passed
          {result.provisional ? " · incomplete inputs" : ""}
        </p>
      </div>
      {showRules ? (
        <ul className="seven-rule-rules">
          {result.rules.map((rule) => (
            <li
              key={rule.id}
              className={`seven-rule-rule ${ruleClass(rule.verdict)}`}
            >
              <span className="seven-rule-rule-label">{rule.label}</span>
              <span className="seven-rule-rule-val">
                {rule.value ?? "—"}
                <span className="seven-rule-rule-thresh"> ({rule.threshold})</span>
              </span>
              <span className="seven-rule-rule-verdict">
                {verdictLabel(rule.verdict)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {compact ? (
        <button
          type="button"
          className="quarters-rank-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide rules" : "Show rules"}
        </button>
      ) : null}
    </div>
  );
}
