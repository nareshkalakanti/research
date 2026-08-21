"use client";

import {
  fmtQVal,
  fmtYoYPct,
  qCellClass,
  yoyClass,
  type PanelYoY,
  type QuarterPanel as QuarterPanelData,
} from "@/lib/quarter-panel";

type Props = {
  panel: QuarterPanelData | null | undefined;
  yoy?: PanelYoY | null;
};

export function QuarterPanel({ panel, yoy }: Props) {
  if (!panel?.labels?.length || !panel.rows?.length) {
    return <div className="q-empty">No quarterly data.</div>;
  }

  const n = panel.labels.length;
  const salesRow = panel.rows.find((r) => r.label === "Sales");
  const allZeroSales =
    !!salesRow?.values.length &&
    salesRow.values.every((v) => v == null || Number(v) === 0);

  return (
    <div className="q-expand">
      <div className="q-block">
        <div className="q-block-title">Quarterly · Rs Cr</div>
        {allZeroSales ? (
          <div className="q-note">
            No operating sales — profit may be other income / one-offs
          </div>
        ) : null}
        <div className="q-panel">
          <table className="q-table">
            <thead>
              <tr>
                <th />
                {panel.labels.map((lb, i) => (
                  <th key={lb} className={i === n - 1 ? "q-latest" : undefined}>
                    {lb}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {panel.rows.map((row) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {panel && yoy ? (
          <p className="q-yoy-foot">
            YoY vs same Q last year
            {yoy.sales_yoy != null ||
            yoy.np_yoy != null ||
            yoy.eps_yoy != null ? (
              <>
                :{" "}
                {yoy.sales_yoy != null ? (
                  <>
                    Sales{" "}
                    <strong className={yoyClass(yoy.sales_yoy)}>
                      {fmtYoYPct(yoy.sales_yoy)}
                    </strong>
                  </>
                ) : null}
                {yoy.sales_yoy != null && yoy.np_yoy != null ? " · " : null}
                {yoy.np_yoy != null ? (
                  <>
                    NP{" "}
                    <strong className={yoyClass(yoy.np_yoy)}>
                      {fmtYoYPct(yoy.np_yoy)}
                    </strong>
                  </>
                ) : null}
                {(yoy.sales_yoy != null || yoy.np_yoy != null) &&
                yoy.eps_yoy != null
                  ? " · "
                  : null}
                {yoy.eps_yoy != null ? (
                  <>
                    EPS{" "}
                    <strong className={yoyClass(yoy.eps_yoy)}>
                      {fmtYoYPct(yoy.eps_yoy)}
                    </strong>
                  </>
                ) : null}
              </>
            ) : (
              <span className="q-yoy-na"> — need same quarter last year</span>
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}
