"use client";

import { useMemo } from "react";

/** Discrete mcap steps in ₹ Cr (null = Max / unbounded). */
export const MCAP_RANGE_STEPS: Array<{ label: string; value: number | null }> = [
  { label: "0", value: 0 },
  { label: "100", value: 100 },
  { label: "500", value: 500 },
  { label: "2k", value: 2000 },
  { label: "10k", value: 10000 },
  { label: "1L", value: 100000 },
  { label: "Max", value: null },
];

export function formatMcapRangeLabel(
  minCr: number | null,
  maxCr: number | null,
): string {
  const lo = minCr ?? 0;
  const hi = maxCr;
  const fmt = (n: number) => {
    if (n >= 100000) return "₹1L cr";
    if (n >= 1000) return `₹${n / 1000}k cr`.replace(".0k", "k");
    return `₹${n.toLocaleString("en-IN")} cr`;
  };
  if ((lo <= 0 || lo === 0) && hi == null) return "Any";
  if (hi == null) return `Over ${fmt(lo)}`;
  if (lo <= 0) return `Up to ${fmt(hi)}`;
  return `${fmt(lo)} – ${fmt(hi)}`;
}

type Props = {
  minIndex: number;
  maxIndex: number;
  onChange: (minIndex: number, maxIndex: number) => void;
  onClear?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
};

export function MarketCapRangeBar({
  minIndex,
  maxIndex,
  onChange,
  onClear,
  onRefresh,
  refreshing,
}: Props) {
  const n = MCAP_RANGE_STEPS.length - 1;
  const lo = Math.max(0, Math.min(minIndex, maxIndex, n));
  const hi = Math.max(lo, Math.min(maxIndex, n));

  const minCr = MCAP_RANGE_STEPS[lo]?.value ?? 0;
  const maxCr = MCAP_RANGE_STEPS[hi]?.value ?? null;
  const label = formatMcapRangeLabel(
    minCr === 0 ? 0 : minCr,
    maxCr,
  );

  const fillLeft = (lo / n) * 100;
  const fillWidth = ((hi - lo) / n) * 100;

  const ticks = useMemo(
    () =>
      MCAP_RANGE_STEPS.map((s, i) => ({
        ...s,
        pct: (i / n) * 100,
      })),
    [n],
  );

  return (
    <div className="mcap-range-bar">
      <div className="mcap-range-main">
        <div className="mcap-range-label">
          Market Cap: <strong>{label}</strong>
        </div>
        <div className="mcap-range-track-wrap">
          <div className="mcap-range-ticks" aria-hidden>
            {ticks.map((t) => (
              <span
                key={t.label}
                className="mcap-range-tick"
                style={{ left: `${t.pct}%` }}
              />
            ))}
          </div>
          <div className="mcap-range-track">
            <div
              className="mcap-range-fill"
              style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }}
            />
            <input
              type="range"
              className="mcap-range-input mcap-range-lo"
              min={0}
              max={n}
              step={1}
              value={lo}
              aria-label="Minimum market cap"
              onChange={(e) => {
                const next = Number(e.target.value);
                onChange(Math.min(next, hi), hi);
              }}
            />
            <input
              type="range"
              className="mcap-range-input mcap-range-hi"
              min={0}
              max={n}
              step={1}
              value={hi}
              aria-label="Maximum market cap"
              onChange={(e) => {
                const next = Number(e.target.value);
                onChange(lo, Math.max(next, lo));
              }}
            />
          </div>
          <div className="mcap-range-scale" aria-hidden>
            {ticks.map((t) => (
              <span
                key={t.label}
                className="mcap-range-scale-label"
                style={{ left: `${t.pct}%` }}
              >
                {t.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      {onClear ? (
        <button
          type="button"
          className="clear-filter mcap-range-clear"
          onClick={onClear}
          title="Clear market-cap filter"
        >
          Clear
        </button>
      ) : null}
      {onRefresh ? (
        <button
          type="button"
          className="mcap-range-refresh"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <span className="mcap-range-refresh-icon" aria-hidden>
            ↻
          </span>
          REFRESH
        </button>
      ) : null}
    </div>
  );
}

export function mcapIndicesToBounds(
  minIndex: number,
  maxIndex: number,
): { minCr: number | null; maxCr: number | null } {
  const n = MCAP_RANGE_STEPS.length - 1;
  const lo = Math.max(0, Math.min(minIndex, maxIndex, n));
  const hi = Math.max(lo, Math.min(maxIndex, n));
  return {
    minCr: MCAP_RANGE_STEPS[lo]?.value ?? 0,
    maxCr: MCAP_RANGE_STEPS[hi]?.value ?? null,
  };
}
