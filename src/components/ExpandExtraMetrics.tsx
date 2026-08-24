"use client";

import {
  cfProfitClass,
  fmtYoYPct,
  yoyClass,
  type QuarterExtraMetrics,
} from "@/lib/quarter-panel";

type Props = {
  extras?: QuarterExtraMetrics | null;
  compact?: boolean;
};

function hasAny(extras: QuarterExtraMetrics | null | undefined): boolean {
  if (!extras) return false;
  return (
    extras.sales_qoq != null ||
    extras.np_qoq != null ||
    extras.eps_qoq != null ||
    extras.ebidt_yoy != null ||
    extras.cf_profit != null
  );
}

function Item({
  label,
  value,
  className,
  title,
}: {
  label: string;
  value: string;
  className?: string;
  title?: string;
}) {
  return (
    <span className="expand-extra-item" title={title}>
      <span className="expand-extra-label">{label}</span>{" "}
      <strong className={className}>{value}</strong>
    </span>
  );
}

/** QoQ · EBIDT YoY · CF/Profit — shown on expand when available. */
export function ExpandExtraMetrics({ extras, compact = false }: Props) {
  if (!hasAny(extras)) return null;

  const qoqParts: Array<{ label: string; val: number }> = [];
  if (extras!.sales_qoq != null) {
    qoqParts.push({ label: "Sales", val: extras!.sales_qoq });
  }
  if (extras!.np_qoq != null) {
    qoqParts.push({ label: "NP", val: extras!.np_qoq });
  }
  if (extras!.eps_qoq != null) {
    qoqParts.push({ label: "EPS", val: extras!.eps_qoq });
  }

  return (
    <div className={`expand-extra${compact ? " expand-extra--compact" : ""}`}>
      {qoqParts.length ? (
        <span className="expand-extra-group">
          <span className="expand-extra-head">QoQ</span>
          {qoqParts.map((p, i) => (
            <span key={p.label}>
              {i > 0 ? (
                <span className="expand-metrics-sep" aria-hidden>
                  ·
                </span>
              ) : null}
              <Item
                label={p.label}
                value={fmtYoYPct(p.val)}
                className={yoyClass(p.val)}
                title={`${p.label} quarter-on-quarter`}
              />
            </span>
          ))}
        </span>
      ) : null}
      {extras!.ebidt_yoy != null ? (
        <>
          {qoqParts.length ? (
            <span className="expand-metrics-sep" aria-hidden>
              ·
            </span>
          ) : null}
          <Item
            label="EBIDT YoY"
            value={fmtYoYPct(extras!.ebidt_yoy)}
            className={yoyClass(extras!.ebidt_yoy)}
            title="Operating profit vs same quarter last year"
          />
        </>
      ) : null}
      {extras!.cf_profit != null ? (
        <>
          {qoqParts.length || extras!.ebidt_yoy != null ? (
            <span className="expand-metrics-sep" aria-hidden>
              ·
            </span>
          ) : null}
          <Item
            label="CF/Profit"
            value={extras!.cf_profit.toFixed(2)}
            className={cfProfitClass(extras!.cf_profit)}
            title="Operating cash flow ÷ net profit (≥1.2 good)"
          />
        </>
      ) : null}
    </div>
  );
}
