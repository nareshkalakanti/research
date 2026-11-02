"use client";

import {
  fmtQVal,
  qCellClass,
  type PanelYoY,
  type QuarterPanel as QuarterPanelData,
  type QuarterRow,
} from "@/lib/quarter-panel";
import {
  classifyQuarterTrend,
  describeQuarterTable,
  overallTrendLabel,
  trendLabelForRow,
  trendShortLabel,
} from "@/lib/quarter-trend";
import { peRowsFromPanel } from "@/lib/valuation";

type Props = {
  panel: QuarterPanelData | null | undefined;
  yoy?: PanelYoY | null;
  price?: number | null;
  sourceNote?: string | null;
  /** Snapshot layout: core P&L rows only, no repeated story / PE / trend. */
  compact?: boolean;
};

function TrendCell({ row }: { row: QuarterRow }) {
  const trend = trendLabelForRow(row);
  if (!trend) return <td className="q-trend q-trend-na">—</td>;
  return (
    <td className={`q-trend q-trend-${trend.tone}`} title={trend.text}>
      <span className="q-trend-pill">{trendShortLabel(trend.text)}</span>
    </td>
  );
}

export function QuarterPanel({
  panel,
  yoy,
  price,
  sourceNote,
  compact = false,
}: Props) {
  if (!panel?.labels?.length || !panel.rows?.length) {
    return <div className="q-empty">No quarterly data.</div>;
  }

  const keep = compact ? Math.min(4, panel.labels.length) : panel.labels.length;
  const labelStart = panel.labels.length - keep;
  const labels = panel.labels.slice(labelStart);
  const n = labels.length;
  const peRows = compact ? [] : peRowsFromPanel(panel, price);
  const core = compact
    ? panel.rows.filter((r) =>
        /^(Sales|Operating Profit|OPM %|Other Income|Net Profit|EPS)/i.test(
          r.label,
        ),
      )
    : panel.rows;
  const displayRows = [
    ...(core.length ? core : panel.rows.slice(0, 4)),
    ...peRows,
  ].map((row) =>
    compact && labelStart > 0
      ? { ...row, values: row.values.slice(labelStart) }
      : row,
  );
  const overall = compact ? null : classifyQuarterTrend(panel, yoy);
  const story = compact
    ? null
    : describeQuarterTable(panel, yoy) || overall?.reason || null;

  const salesRow = panel.rows.find((r) => r.label === "Sales");
  const allZeroSales =
    !!salesRow?.values.length &&
    salesRow.values.every((v) => v == null || Number(v) === 0);

  return (
    <div className="q-expand">
      <div className="q-block">
        {sourceNote ? (
          <p className="q-source-note">{sourceNote}</p>
        ) : null}
        <div className="q-block-head">
          <div className="q-block-title">
            {compact ? "Quarterly (Rs Cr)" : "Quarterly · ₹ Cr"}
          </div>
          <div className="q-block-meta">
            {overall ? (
              <span
                className={`q-overall-trend q-overall-trend--${overall.signal.toLowerCase()}`}
                title={overall.reason}
              >
                {overallTrendLabel(overall.signal)}
              </span>
            ) : null}
          </div>
        </div>
        {story ? <p className="q-story">{story}</p> : null}
        {allZeroSales ? (
          <div className="q-note">
            No operating sales — profit may be other income / one-offs
          </div>
        ) : null}
        <div className="q-panel">
          <table className="q-table">
            <colgroup>
              <col className="q-col-metric" />
              {labels.map((lb) => (
                <col key={lb} className="q-col-qtr" />
              ))}
              {compact ? null : <col className="q-col-trend" />}
            </colgroup>
            <thead>
              <tr>
                <th>Metric</th>
                {labels.map((lb, i) => (
                  <th key={lb} className={i === n - 1 ? "q-latest" : undefined}>
                    {lb}
                  </th>
                ))}
                {compact ? null : <th className="q-trend-col">Trend</th>}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => {
                const fullRow =
                  compact && labelStart > 0
                    ? (panel.rows.find((r) => r.label === row.label) ?? row)
                    : row;
                return (
                  <tr key={row.label}>
                    <td className="q-label">{row.label}</td>
                    {row.values.map((v, i) => {
                      const tone = qCellClass(
                        fullRow,
                        compact && labelStart > 0 ? labelStart + i : i,
                      );
                      const latest = i === n - 1 ? "q-latest" : "";
                      const cls = [tone, latest].filter(Boolean).join(" ");
                      return (
                        <td
                          key={`${row.label}-${i}`}
                          className={cls || undefined}
                        >
                          {fmtQVal(v, row.decimals)}
                        </td>
                      );
                    })}
                    {compact ? null : <TrendCell row={row} />}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
