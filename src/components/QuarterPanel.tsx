"use client";

import {
  fmtQVal,
  fmtYoYPct,
  qCellClass,
  yoyClass,
  type PanelYoY,
  type QuarterPanel as QuarterPanelData,
  type QuarterRow,
} from "@/lib/quarter-panel";
import { classifyQuarterTrend, trendLabelForRow, trendShortLabel } from "@/lib/quarter-trend";
import { peRowsFromPanel } from "@/lib/valuation";

type Props = {
  panel: QuarterPanelData | null | undefined;
  yoy?: PanelYoY | null;
  price?: number | null;
  sourceNote?: string | null;
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

export function QuarterPanel({ panel, yoy, price, sourceNote }: Props) {
  if (!panel?.labels?.length || !panel.rows?.length) {
    return <div className="q-empty">No quarterly data.</div>;
  }

  const n = panel.labels.length;
  const peRows = peRowsFromPanel(panel, price);
  const displayRows = [...panel.rows, ...peRows];
  const overall = classifyQuarterTrend(panel, yoy);

  const salesRow = panel.rows.find((r) => r.label === "Sales");
  const allZeroSales =
    !!salesRow?.values.length &&
    salesRow.values.every((v) => v == null || Number(v) === 0);
  const hasYoY =
    !!yoy &&
    (yoy.sales_yoy != null ||
      yoy.np_yoy != null ||
      yoy.eps_yoy != null ||
      yoy.ebidt_yoy != null);

  return (
    <div className="q-expand">
      <div className="q-block">
        {sourceNote ? (
          <p className="q-source-note">{sourceNote}</p>
        ) : null}
        <div className="q-block-head">
          <div className="q-block-title">Quarterly · Rs Cr</div>
          <div className="q-block-meta">
            {price != null && price > 0 ? (
              <span className="q-ltp" title="Last traded price">
                LTP ₹{price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </span>
            ) : null}
            {overall ? (
              <span
                className={`q-overall-trend q-overall-trend--${overall.signal.toLowerCase()}`}
                title={overall.reason}
              >
                {overall.signal}
              </span>
            ) : null}
          </div>
        </div>
        {allZeroSales ? (
          <div className="q-note">
            No operating sales — profit may be other income / one-offs
          </div>
        ) : null}
        <div className="q-panel">
          <table className="q-table">
            <colgroup>
              <col className="q-col-metric" />
              {panel.labels.map((lb) => (
                <col key={lb} className="q-col-qtr" />
              ))}
              <col className="q-col-trend" />
            </colgroup>
            <thead>
              <tr>
                <th>Metric</th>
                {panel.labels.map((lb, i) => (
                  <th key={lb} className={i === n - 1 ? "q-latest" : undefined}>
                    {lb}
                  </th>
                ))}
                <th className="q-trend-col">Trend</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => (
                <tr key={row.label}>
                  <td className="q-label">{row.label}</td>
                  {row.values.map((v, i) => {
                    const tone = qCellClass(row, i);
                    const latest = i === n - 1 ? "q-latest" : "";
                    const cls = [tone, latest].filter(Boolean).join(" ");
                    return (
                      <td key={`${row.label}-${i}`} className={cls || undefined}>
                        {fmtQVal(v, row.decimals)}
                      </td>
                    );
                  })}
                  <TrendCell row={row} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hasYoY ? (
          <p className="q-yoy-foot">
            YoY vs same Q last year:{" "}
            {yoy!.sales_yoy != null ? (
              <>
                Sales{" "}
                <strong className={yoyClass(yoy!.sales_yoy)}>
                  {fmtYoYPct(yoy!.sales_yoy)}
                </strong>
              </>
            ) : null}
            {yoy!.sales_yoy != null && yoy!.np_yoy != null ? " · " : null}
            {yoy!.np_yoy != null ? (
              <>
                NP{" "}
                <strong className={yoyClass(yoy!.np_yoy)}>
                  {fmtYoYPct(yoy!.np_yoy)}
                </strong>
              </>
            ) : null}
            {(yoy!.sales_yoy != null || yoy!.np_yoy != null) &&
            yoy!.eps_yoy != null
              ? " · "
              : null}
            {yoy!.eps_yoy != null ? (
              <>
                EPS{" "}
                <strong className={yoyClass(yoy!.eps_yoy)}>
                  {fmtYoYPct(yoy!.eps_yoy)}
                </strong>
              </>
            ) : null}
            {(yoy!.sales_yoy != null ||
              yoy!.np_yoy != null ||
              yoy!.eps_yoy != null) &&
            yoy!.ebidt_yoy != null
              ? " · "
              : null}
            {yoy!.ebidt_yoy != null ? (
              <>
                EBIDT{" "}
                <strong className={yoyClass(yoy!.ebidt_yoy)}>
                  {fmtYoYPct(yoy!.ebidt_yoy)}
                </strong>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
