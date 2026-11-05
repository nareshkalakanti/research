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
 * Compact quarters rank (growth mean + Growing/Mixed/Declining), with expand
 * to the full quarter table — same card rhythm as 7-Rule / Performance.
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
      <div className="seven-rule-head">
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
          <>
            <div className="seven-rule-bar" aria-hidden>
              <div
                className={`seven-rule-bar-fill ${barCls}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="seven-rule-sub" title={rank.reason}>
              {rank.metrics.length
                ? rank.metrics.map((m) => m.label).join(" · ")
                : rank.reason}
            </p>
          </>
        ) : null}
      </div>

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

      <button
        type="button"
        className="quarters-rank-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "Hide quarter table" : "Show quarter table"}
      </button>

      {expanded ? (
        <div className="quarters-rank-table">
          <ExpandQuarters data={data} price={price} compact richQoq={richQoq} />
        </div>
      ) : null}
    </div>
  );
}
