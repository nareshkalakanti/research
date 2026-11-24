"use client";

import { useMemo } from "react";
import {
  earningsGradeFromBand,
  quarterRankFromPanel,
  type EarningsTrendGrade,
} from "@/lib/quarter-rank";
import type { PanelYoY, QuarterPanel } from "@/lib/quarter-panel";

const MONTH_IX: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/** Indian FY label from panel month label ("Jun 2026" → "Q1 FY27"). */
export function toFyLabel(panelLabel: string): string {
  const m = panelLabel.match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return panelLabel;
  const mi = MONTH_IX[m[1]!];
  const y = Number(m[2]);
  if (mi == null || !Number.isFinite(y)) return panelLabel;
  let q: number;
  let fy: number;
  if (mi >= 3 && mi <= 5) {
    q = 1;
    fy = y + 1;
  } else if (mi >= 6 && mi <= 8) {
    q = 2;
    fy = y + 1;
  } else if (mi >= 9 && mi <= 11) {
    q = 3;
    fy = y + 1;
  } else {
    q = 4;
    fy = y;
  }
  return `Q${q} FY${String(fy).slice(2)}`;
}

/** Quarterly panel values are already in ₹ crore — keep the unit consistent. */
export function fmtInrCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: digits })} Cr`;
}

export function fmtYoY(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/** Quarterly Revenue vs Earnings chart (Value Earnings Trends + Napkin). */
export function RevenueEarningsChart({
  panel,
  yoy,
  name,
  ticker,
  market,
  loading,
  error,
  warning,
  compact,
}: {
  /** Smaller chart (Napkin): shorter drawing area, text stays readable. */
  compact?: boolean;
  /** Data check warning (doesn't match annual report, jumps, stale): shown above the chart. */
  warning?: string | null;
  panel: QuarterPanel | null;
  yoy: PanelYoY | null;
  name: string;
  ticker: string;
  market?: string | null;
  loading?: boolean;
  error?: string | null;
}) {
  const rank = useMemo(
    () => (panel?.labels?.length ? quarterRankFromPanel(panel, yoy) : null),
    [panel, yoy],
  );
  const grade: EarningsTrendGrade | null = rank ? earningsGradeFromBand(rank.band) : null;

  const chart = useMemo(() => {
    if (!panel?.labels.length) return null;
    const sales = panel.rows.find((r) => r.label === "Sales")?.values ?? [];
    const np = panel.rows.find((r) => r.label === "Net Profit")?.values ?? [];
    const ebit = panel.rows.find((r) => r.label === "Operating Profit")?.values ?? [];
    const n = panel.labels.length;
    const vals = [...sales, ...np].filter((v): v is number => v != null && Number.isFinite(v));
    if (!vals.length) return null;
    const lo = Math.min(0, ...vals);
    const hi = Math.max(...vals);
    const span = hi - lo || 1;
    const w = compact ? 520 : 640;
    const h = compact ? 170 : 280;
    const padL = 52;
    const padR = 16;
    const padT = 16;
    const padB = compact ? 30 : 36;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const groupW = innerW / n;
    const barW = Math.min(28, groupW * 0.32);
    const yAt = (v: number) => padT + innerH - ((v - lo) / span) * innerH;
    const zeroY = yAt(0);
    const bars: Array<{ x: number; y: number; bh: number; kind: "rev" | "earn" }> = [];
    for (let i = 0; i < n; i += 1) {
      const cx = padL + i * groupW + groupW / 2;
      const rv = sales[i];
      const ev = np[i];
      if (rv != null) {
        const y = yAt(Math.max(rv, 0));
        const y2 = yAt(Math.min(rv, 0));
        bars.push({ x: cx - barW - 2, y, bh: Math.max(1, y2 - y), kind: "rev" });
      }
      if (ev != null) {
        const y = yAt(Math.max(ev, 0));
        const y2 = yAt(Math.min(ev, 0));
        bars.push({ x: cx + 2, y, bh: Math.max(1, y2 - y), kind: "earn" });
      }
    }
    const yTicks = [lo, (lo + hi) / 2, hi].map((v) => Math.round(v * 10) / 10);
    return {
      w,
      h,
      padL,
      padR,
      labels: panel.labels.map(toFyLabel),
      bars,
      yTicks,
      yAt,
      zeroY,
      groupW,
      sales,
      np,
      ebit,
      lastI: n - 1,
    };
  }, [panel, compact]);

  if (loading) {
    return <p className="vx-empty">Loading quarters for {ticker}…</p>;
  }
  if (error) {
    return <p className="vx-msg vx-msg--err">{error}</p>;
  }
  if (!chart) {
    return <p className="vx-empty">No quarterly series for {ticker}.</p>;
  }

  const lastRev = chart.sales[chart.lastI];
  const lastEarn = chart.np[chart.lastI];
  const lastEbit = chart.ebit[chart.lastI];
  const margin =
    lastRev != null && lastEarn != null && lastRev !== 0 ? (lastEarn / lastRev) * 100 : null;
  const mkt = (market || "").trim();

  return (
    <>
      <div className="vx-earn-head">
        <div>
          <h3 className="vx-earn-title">Revenue vs. Earnings</h3>
          <p className="vx-earn-sub">
            {name} ({ticker}
            {mkt ? `.${mkt}` : ""})
          </p>
          {warning ? <p className="vx-earn-warn">⚠ {warning}</p> : null}
          <div className="vx-earn-legend">
            <span className="vx-earn-leg vx-earn-leg--rev">Revenue {fmtInrCr(lastRev)}</span>
            <span className="vx-earn-leg vx-earn-leg--earn">Earnings {fmtInrCr(lastEarn)}</span>
          </div>
          {grade && rank ? (
            <p className={`vx-earn-grade vx-earn-grade--${grade.toLowerCase()}`} title={rank.summary}>
              <strong>{grade}</strong>
              <span>
                · score {rank.score.toFixed(1)}/10 · {rank.summary}
              </span>
            </p>
          ) : null}
        </div>
        <span className="vx-earn-period">Quarterly</span>
      </div>

      <div className="vx-earn-body">
        <svg
          className="vx-earn-svg"
          viewBox={`0 0 ${chart.w} ${chart.h}`}
          width="100%"
          role="img"
          aria-label={`Quarterly revenue and earnings for ${ticker}`}
        >
          {chart.yTicks.map((t) => (
            <g key={t}>
              <line
                className="vx-earn-guide"
                x1={chart.padL}
                x2={chart.w - chart.padR}
                y1={chart.yAt(t)}
                y2={chart.yAt(t)}
              />
              <text className="vx-earn-axis" x={chart.padL - 6} y={chart.yAt(t) + 3} textAnchor="end">
                {fmtInrCr(t)}
              </text>
            </g>
          ))}
          <line
            className="vx-earn-guide"
            x1={chart.padL}
            x2={chart.w - chart.padR}
            y1={chart.zeroY}
            y2={chart.zeroY}
          />
          {chart.bars.map((b, i) => (
            <rect
              key={i}
              className={b.kind === "rev" ? "vx-earn-bar--rev" : "vx-earn-bar--earn"}
              x={b.x}
              y={b.y}
              width={Math.min(28, chart.groupW * 0.32)}
              height={b.bh}
              rx="3"
            />
          ))}
          {chart.labels.map((lab, i) => (
            <text
              key={lab + i}
              className="vx-earn-axis"
              x={chart.padL + i * chart.groupW + chart.groupW / 2}
              y={chart.h - 10}
              textAnchor="middle"
            >
              {lab}
            </text>
          ))}
        </svg>

        <aside className="vx-earn-metrics">
          <span className="vx-label vx-label--title">Latest metrics ({chart.labels[chart.lastI]})</span>
          <div className="vx-earn-metric">
            <span>Revenue YoY</span>
            <strong className={(yoy?.sales_yoy ?? 0) >= 0 ? "pos-t" : "neg"}>{fmtYoY(yoy?.sales_yoy)}</strong>
          </div>
          <div className="vx-earn-metric">
            <span>Earnings YoY</span>
            <strong className={(yoy?.np_yoy ?? 0) >= 0 ? "pos-t" : "neg"}>{fmtYoY(yoy?.np_yoy)}</strong>
          </div>
          <div className="vx-earn-metric">
            <span>EBITDA</span>
            <strong>{fmtInrCr(lastEbit)}</strong>
          </div>
          <div className="vx-earn-metric">
            <span>Profit Margin</span>
            <strong>{margin == null ? "—" : `${margin.toFixed(2)}%`}</strong>
          </div>
        </aside>
      </div>
    </>
  );
}
