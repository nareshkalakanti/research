"use client";

import { useEffect, useMemo, useState } from "react";

/** Discrete mcap steps in ₹ Cr (null = Max / unbounded). */
export const MCAP_RANGE_STEPS: Array<{ label: string; value: number | null }> = [
  { label: "0", value: 0 },
  { label: "100", value: 100 },
  { label: "500", value: 500 },
  { label: "1k", value: 1000 },
  { label: "2k", value: 2000 },
  { label: "3k", value: 3000 },
  { label: "5k", value: 5000 },
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
    if (n >= 1000) {
      const k = n / 1000;
      return Number.isInteger(k)
        ? `₹${k}k cr`
        : `₹${k.toLocaleString("en-IN", { maximumFractionDigits: 1 })}k cr`;
    }
    return `₹${n.toLocaleString("en-IN")} cr`;
  };
  if ((lo <= 0 || lo === 0) && hi == null) return "Any";
  if (hi == null) return `Over ${fmt(lo)}`;
  if (lo <= 0) return `Up to ${fmt(hi)}`;
  return `${fmt(lo)} – ${fmt(hi)}`;
}

/** Nearest step index for a Cr value (null = Max). */
export function mcapCrToIndex(cr: number | null): number {
  const n = MCAP_RANGE_STEPS.length - 1;
  if (cr == null) return n;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < MCAP_RANGE_STEPS.length; i += 1) {
    const v = MCAP_RANGE_STEPS[i]?.value;
    if (v == null) continue;
    const d = Math.abs(v - cr);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
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

/** Typed override from the Min/Max inputs (null = follow slider steps). */
export type McapExactBounds = { minCr: number; maxCr: number | null };

export function resolveMcapBounds(
  minIndex: number,
  maxIndex: number,
  exact: McapExactBounds | null | undefined,
): { minCr: number | null; maxCr: number | null } {
  if (exact) return { minCr: exact.minCr, maxCr: exact.maxCr };
  return mcapIndicesToBounds(minIndex, maxIndex);
}

export function mcapBoundsNarrowed(
  minCr: number | null | undefined,
  maxCr: number | null | undefined,
): boolean {
  return (minCr ?? 0) > 0 || maxCr != null;
}

function parseCrInput(raw: string): number | null | undefined {
  const t = raw.trim().toLowerCase().replace(/,/g, "");
  if (t === "" || t === "any" || t === "max" || t === "∞") return null;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (m) {
    const n = Number(m[1]) * 1000;
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

type Props = {
  minIndex: number;
  maxIndex: number;
  onChange: (minIndex: number, maxIndex: number) => void;
  /** Exact ₹ Cr bounds — when set, filter uses these instead of step values. */
  minCr?: number | null;
  maxCr?: number | null;
  onCrChange?: (minCr: number | null, maxCr: number | null) => void;
  onClear?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Tighter layout for Scan / dense toolbars. */
  compact?: boolean;
  /** Hide the "Market Cap:" prefix (row already has an Mcap label). */
  valueOnly?: boolean;
};

export function MarketCapRangeBar({
  minIndex,
  maxIndex,
  onChange,
  minCr: minCrProp,
  maxCr: maxCrProp,
  onCrChange,
  onClear,
  onRefresh,
  refreshing,
  compact = false,
  valueOnly = false,
}: Props) {
  const n = MCAP_RANGE_STEPS.length - 1;
  const lo = Math.max(0, Math.min(minIndex, maxIndex, n));
  const hi = Math.max(lo, Math.min(maxIndex, n));

  const stepMin = MCAP_RANGE_STEPS[lo]?.value ?? 0;
  const stepMax = MCAP_RANGE_STEPS[hi]?.value ?? null;
  const minCr =
    minCrProp !== undefined ? minCrProp ?? 0 : stepMin === 0 ? 0 : stepMin;
  const maxCr = maxCrProp !== undefined ? maxCrProp : stepMax;
  const label = formatMcapRangeLabel(minCr === 0 ? 0 : minCr, maxCr);

  const [minDraft, setMinDraft] = useState(() =>
    minCr > 0 ? String(minCr) : "",
  );
  const [maxDraft, setMaxDraft] = useState(() =>
    maxCr == null ? "" : String(maxCr),
  );

  useEffect(() => {
    setMinDraft(minCr > 0 ? String(minCr) : "");
  }, [minCr]);
  useEffect(() => {
    setMaxDraft(maxCr == null ? "" : String(maxCr));
  }, [maxCr]);

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

  function emitCr(nextMin: number | null, nextMax: number | null) {
    let loCr = nextMin == null || nextMin <= 0 ? 0 : nextMin;
    let hiCr = nextMax;
    if (hiCr != null && loCr > hiCr) {
      const tmp = loCr;
      loCr = hiCr;
      hiCr = tmp;
    }
    onChange(mcapCrToIndex(loCr <= 0 ? 0 : loCr), mcapCrToIndex(hiCr));
    onCrChange?.(loCr <= 0 ? 0 : loCr, hiCr);
  }

  function commitMin() {
    const parsed = parseCrInput(minDraft);
    if (parsed === undefined) {
      setMinDraft(minCr > 0 ? String(minCr) : "");
      return;
    }
    emitCr(parsed, maxCr);
  }

  function commitMax() {
    const parsed = parseCrInput(maxDraft);
    if (parsed === undefined) {
      setMaxDraft(maxCr == null ? "" : String(maxCr));
      return;
    }
    emitCr(minCr, parsed);
  }

  return (
    <div
      className={`mcap-range-bar${compact ? " mcap-range-bar--compact" : ""}`}
    >
      <div className="mcap-range-main">
        <div className="mcap-range-label-row">
          <div className="mcap-range-label">
            {valueOnly ? (
              <strong>{label}</strong>
            ) : (
              <>
                Market Cap: <strong>{label}</strong>
              </>
            )}
          </div>
          <div className="mcap-range-inputs">
            <label className="mcap-range-num">
              <span>Min</span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={minDraft}
                aria-label="Minimum market cap in ₹ Cr"
                onChange={(e) => setMinDraft(e.target.value)}
                onBlur={commitMin}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
              />
            </label>
            <span className="mcap-range-num-sep" aria-hidden>
              –
            </span>
            <label className="mcap-range-num">
              <span>Max</span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="Max"
                value={maxDraft}
                aria-label="Maximum market cap in ₹ Cr"
                onChange={(e) => setMaxDraft(e.target.value)}
                onBlur={commitMax}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
              />
            </label>
            <span className="mcap-range-unit">₹ Cr</span>
          </div>
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
                const nextLo = Math.min(next, hi);
                const bounds = mcapIndicesToBounds(nextLo, hi);
                onChange(nextLo, hi);
                onCrChange?.(bounds.minCr ?? 0, bounds.maxCr);
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
                const nextHi = Math.max(next, lo);
                const bounds = mcapIndicesToBounds(lo, nextHi);
                onChange(lo, nextHi);
                onCrChange?.(bounds.minCr ?? 0, bounds.maxCr);
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
