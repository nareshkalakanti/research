"use client";

import { useMemo, useState } from "react";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import {
  quarterRankFromPanel,
  quarterRankRatingClass,
} from "@/lib/quarter-rank";
import type { ExpandQuarterData } from "@/lib/use-expand-quarters";

type Props = {
  data: ExpandQuarterData;
  price?: number | null;
  /** Show rich QoQ deltas in the expanded table. */
  richQoq?: boolean;
  /** Start with the table open. */
  defaultExpanded?: boolean;
  className?: string;
};

/**
 * Compact quarters rank (growth mean + Growing/Mixed/Declining).
 * Click the score head to expand the quarter table — no subtitle / Show link.
 */
export function QuartersRankCard({
  data,
  price,
  richQoq = false,
  defaultExpanded = false,
  className,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const rank = useMemo(() => {
    if (!data.panel?.labels?.length) return null;
    return quarterRankFromPanel(data.panel, data.yoy);
  }, [data.panel, data.yoy]);

  const root = ["seven-rule-card", "quarters-rank-card", className]
    .filter(Boolean)
    .join(" ");

  if (data.loading && !data.panel) {
    return (
      <div className={root}>
        <p className="table-meta">Loading quarters…</p>
      </div>
    );
  }
  if (data.error) {
    return (
      <div className={root}>
        <p className="table-meta">{data.error}</p>
      </div>
    );
  }
  if (!data.panel?.labels?.length) {
    return (
      <div className={root}>
        <p className="table-meta">No quarterly data</p>
      </div>
    );
  }

  const barCls = rank ? quarterRankRatingClass(rank.signal) : "";
  const pct = rank
    ? Math.min(100, Math.max(0, ((rank.score + 50) / 100) * 100))
    : 0;

  return (
    <div className={`${root}${expanded ? "" : " seven-rule-card--compact"}`}>
      <button
        type="button"
        className="quarters-rank-head-btn"
        aria-expanded={expanded}
        title={expanded ? "Hide quarters" : "Show quarters"}
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="seven-rule-score-line">
          {rank ? (
            <>
              <span className="seven-rule-score-num">
                {rank.score >= 0 ? "+" : ""}
                {rank.score.toFixed(1)}
              </span>
              <span className="seven-rule-score-denom">growth</span>
              <span className={`seven-rule-rating ${barCls}`}>
                {rank.ratingLabel}
              </span>
            </>
          ) : (
            <span className="seven-rule-score-denom">No growth score</span>
          )}
        </div>
        {rank ? (
          <div className="seven-rule-bar" aria-hidden>
            <div
              className={`seven-rule-bar-fill ${barCls}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}
      </button>

      {expanded && rank?.metrics.length ? (
        <ul className="seven-rule-rules quarters-rank-metrics">
          {rank.metrics.map((m) => (
            <li
              key={m.id}
              className={`seven-rule-rule ${
                m.tone === "good"
                  ? "seven-rule-rule--pass"
                  : m.tone === "bad"
                    ? "seven-rule-rule--fail"
                    : "seven-rule-rule--unknown"
              }`}
            >
              <span className="seven-rule-rule-label">{m.label}</span>
              <span className="seven-rule-rule-val">{m.value}</span>
              <span className="seven-rule-rule-verdict">
                {m.tone === "good" ? "Up" : m.tone === "bad" ? "Down" : "Flat"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {expanded ? (
        <div className="quarters-rank-table">
          <ExpandQuarters data={data} price={price} compact richQoq={richQoq} />
        </div>
      ) : null}
    </div>
  );
}
