"use client";

import type { ExpandQuarterData } from "@/lib/use-expand-quarters";
import {
  epsFromQuarterPanel,
  epsPeriodsPerYear,
  FORWARD_PE_NM,
  formatPeDisplay,
  forwardPeClass,
  forwardPeRunRate,
} from "@/lib/valuation";

const fmtEps = (v: number) =>
  `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * Compact header stat: P/E and Fwd PE (latest result's EPS × 4 for quarterly
 * filers, × 2 for half-yearly; the trailing year if the latest is a loss).
 */
export function NapkinPeStrip({
  data,
  pe,
  ttmEps,
}: {
  data: ExpandQuarterData;
  /** Trailing P/E as displayed in the Napkin overview. */
  pe?: string | null;
  /** Trailing 12-month EPS — negative means P/E is a loss, not missing. */
  ttmEps?: number | null;
}) {
  const fpe = data.forward_pe;
  const loading = data.loading && !data.panel;
  const fpeNm = fpe != null && fpe >= FORWARD_PE_NM;
  // 999 = loss-making (no positive EPS run-rate) or a real PE above 500.
  const qEps = data.panel ? epsFromQuarterPanel(data.panel) : [];
  const perYear = data.panel ? epsPeriodsPerYear(data.panel.labels) : 4;
  const fpeLoss = fpeNm && qEps.length > 0 && forwardPeRunRate(qEps, perYear) == null;
  const period = perYear === 2 ? "half-year" : "quarter";
  const latestQ = qEps.length ? qEps[qEps.length - 1]! : null;
  const peMissing = !pe || pe === "N/A" || pe === "N/Ax";
  const peLoss = peMissing && ttmEps != null && ttmEps < 0;

  return (
    <div className="napkin-pe-strip" aria-busy={loading}>
      <div
        className="napkin-pe-stat"
        title={
          peLoss
            ? `Loss-making: last 12 months EPS ${fmtEps(ttmEps!)} — P/E not meaningful.`
            : "Trailing P/E: price ÷ last 12 months EPS."
        }
      >
        <span className="napkin-pe-stat-label">P/E</span>
        <span className={`napkin-pe-stat-num${peLoss ? " fpe-bad" : ""}`}>
          {peLoss ? "Loss" : peMissing ? "—" : pe}
        </span>
      </div>
      <div
        className="napkin-pe-stat"
        title={
          fpeLoss
            ? `Loss-making: latest ${period} EPS ${latestQ != null ? fmtEps(latestQ) : "negative"} and no profitable trailing year — Fwd PE not meaningful.`
            : `Fwd PE: price ÷ latest ${period} EPS × ${perYear} (trailing year if latest is a loss). N/M = above 500.`
        }
      >
        <span className="napkin-pe-stat-label">Fwd PE</span>
        <span
          className={`napkin-pe-stat-num ${
            fpe == null ? "fpe-na" : forwardPeClass(fpe)
          }`}
        >
          {loading
            ? "…"
            : fpe == null
              ? "—"
              : fpeLoss
                ? "Loss"
                : fpeNm
                  ? "N/M"
                  : formatPeDisplay(fpe)}
        </span>
      </div>
    </div>
  );
}
