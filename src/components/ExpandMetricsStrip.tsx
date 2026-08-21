"use client";

import { fmtYoYPct, yoyClass } from "@/lib/quarter-panel";
import { formatPeDisplay, forwardPeClass } from "@/lib/valuation";

type Props = {
  forwardPe?: number | null;
  epsYoY?: number | null;
  loading?: boolean;
  /** Fetch finished but no quarter metrics available. */
  empty?: boolean;
};

/** Two headline metrics — shown on every expand, all tabs. */
export function ExpandMetricsStrip({
  forwardPe,
  epsYoY,
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

  if (empty || (forwardPe == null && epsYoY == null)) {
    return (
      <div className="expand-metrics expand-metrics--empty">
        <span className="expand-metrics-muted">
          Quarter metrics unavailable — no EPS / YoY data from source
        </span>
      </div>
    );
  }

  return (
    <div className="expand-metrics">
      {forwardPe != null ? (
        <span className="expand-metrics-item">
          <span className="expand-metrics-label">Fwd PE</span>
          <strong
            className={forwardPeClass(forwardPe)}
            title="Price ÷ (latest quarter EPS × 4)"
          >
            {formatPeDisplay(forwardPe)}
          </strong>
        </span>
      ) : (
        <span className="expand-metrics-item">
          <span className="expand-metrics-label">Fwd PE</span>
          <strong className="expand-metrics-muted" title="No EPS data">
            —
          </strong>
        </span>
      )}
      <span className="expand-metrics-sep" aria-hidden>
        ·
      </span>
      {epsYoY != null ? (
        <span className="expand-metrics-item">
          <span className="expand-metrics-label">EPS YoY</span>
          <strong
            className={yoyClass(epsYoY)}
            title="Latest quarter vs same quarter last year"
          >
            {fmtYoYPct(epsYoY)}
          </strong>
        </span>
      ) : (
        <span className="expand-metrics-item">
          <span className="expand-metrics-label">EPS YoY</span>
          <strong className="expand-metrics-muted" title="No YoY data">
            —
          </strong>
        </span>
      )}
    </div>
  );
}
