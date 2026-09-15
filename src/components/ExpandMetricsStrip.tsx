"use client";

import type { ReactNode } from "react";
import {
  cfProfitClass,
  type PanelYoY,
  type QuarterExtraMetrics,
  type QuarterPanel,
} from "@/lib/quarter-panel";
import {
  classifyQuarterTrend,
  describeQuarterTable,
  overallTrendLabel,
} from "@/lib/quarter-trend";
import { formatPeDisplay, forwardPeClass } from "@/lib/valuation";

type Props = {
  panel?: QuarterPanel | null;
  forwardPe?: number | null;
  yoy?: PanelYoY | null;
  extras?: QuarterExtraMetrics | null;
  loading?: boolean;
  /** Fetch finished but no quarter metrics available. */
  empty?: boolean;
};

function Stat({
  label,
  children,
  title,
}: {
  label: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className="expand-stat" title={title}>
      <span className="expand-stat-label">{label}</span>
      <span className="expand-stat-value">{children}</span>
    </span>
  );
}

/**
 * Compact expand headline: Fwd PE + CF/P + one plain-language read of the table.
 * YoY/QoQ % grids removed — the Qtr table already shows sequential colour.
 */
export function ExpandMetricsStrip({
  panel,
  forwardPe,
  yoy,
  extras,
  loading,
  empty,
}: Props) {
  if (loading) {
    return (
      <div className="expand-metrics expand-metrics--loading">
        <span className="expand-metrics-muted">Loading metrics…</span>
      </div>
    );
  }

  if (empty) {
    return (
      <div className="expand-metrics expand-metrics--empty">
        <span className="expand-metrics-muted">
          Quarter metrics unavailable — no quarterly data from source
        </span>
      </div>
    );
  }

  const cf = extras?.cf_profit ?? null;
  const overall = panel ? classifyQuarterTrend(panel, yoy) : null;
  const story =
    (panel ? describeQuarterTable(panel, yoy) : null) || overall?.reason || null;

  return (
    <div className="expand-metrics" aria-label="Quarter snapshot">
      <div className="expand-metrics-group expand-metrics-group--stats">
        <Stat
          label="Fwd PE"
          title="Price ÷ annualized EPS (latest quarter × 4)"
        >
          {forwardPe != null ? (
            <strong className={forwardPeClass(forwardPe)}>
              {formatPeDisplay(forwardPe)}
            </strong>
          ) : (
            <strong className="expand-metrics-muted">—</strong>
          )}
        </Stat>
        {cf != null ? (
          <Stat label="CF/P" title="Operating cash flow ÷ net profit (≥1.2 good)">
            <strong className={cfProfitClass(cf)}>{cf.toFixed(2)}</strong>
          </Stat>
        ) : null}
        {overall ? (
          <span
            className={`expand-metrics-signal expand-metrics-signal--${overall.signal.toLowerCase()}`}
            title={overall.reason}
          >
            {overallTrendLabel(overall.signal)}
          </span>
        ) : null}
      </div>

      {story ? (
        <p className="expand-metrics-story" title={overall?.reason ?? undefined}>
          {story}
        </p>
      ) : null}
    </div>
  );
}
