"use client";

import { useMemo } from "react";
import {
  earnAnnouncementWindowForFyQuarter,
  fyQuarterChipLabel,
  fyQuarterExplain,
  isoDate,
} from "@/lib/strategy/concall-drift-quarters";
import { LiveNseFeedBadge } from "@/components/LiveNseFeedBadge";
import type { NseFeedStatus } from "@/lib/nse-feed-status-types";

export type ConcallDriftSort = "all" | "gainers" | "losers";

export type ConcallDriftDatePreset =
  | ""
  | "yesterday"
  | "today"
  | "tomorrow"
  | "next7"
  | "last7"
  | "custom";

type McapBounds = { min: number; max: number };

type Props = {
  sort: ConcallDriftSort;
  onSort: (sort: ConcallDriftSort) => void;
  datePreset: ConcallDriftDatePreset;
  onDatePreset: (preset: ConcallDriftDatePreset) => void;
  quarter: string;
  onQuarter: (quarter: string) => void;
  quarterOptions: string[];
  customFrom: string;
  customTo: string;
  onCustomFrom: (v: string) => void;
  onCustomTo: (v: string) => void;
  sector: string;
  onSector: (sector: string) => void;
  sectors: string[];
  mcapMin: number | null;
  mcapMax: number | null;
  onMcapMin: (v: number) => void;
  onMcapMax: (v: number) => void;
  mcapBounds: McapBounds | null;
  search: string;
  onSearch: (q: string) => void;
  withBaseline?: number;
  totalEvents?: number;
  nseFeed?: NseFeedStatus;
};

const DATE_PRESETS: Array<{ id: ConcallDriftDatePreset; label: string }> = [
  { id: "yesterday", label: "Yesterday" },
  { id: "today", label: "Today" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "next7", label: "Next 7 days" },
  { id: "last7", label: "Last 7 days" },
  { id: "custom", label: "Custom" },
];

function fmtCr(n: number): string {
  if (n >= 100_000) return `${(n / 100_000).toFixed(1)}L Cr`;
  if (n >= 1000) return `${Math.round(n).toLocaleString("en-IN")} Cr`;
  if (n >= 100) return `${Math.round(n)} Cr`;
  if (n >= 10) return `${n.toFixed(0)} Cr`;
  return `${n.toFixed(1)} Cr`;
}

export function ConcallDriftFilterBar({
  sort,
  onSort,
  datePreset,
  onDatePreset,
  quarter,
  onQuarter,
  quarterOptions,
  customFrom,
  customTo,
  onCustomFrom,
  onCustomTo,
  sector,
  onSector,
  sectors,
  mcapMin,
  mcapMax,
  onMcapMin,
  onMcapMax,
  mcapBounds,
  search,
  onSearch,
  withBaseline,
  totalEvents,
  nseFeed,
}: Props) {
  const bounds = mcapBounds ?? { min: 0, max: 1000 };
  const lo = Math.min(
    bounds.max,
    Math.max(bounds.min, mcapMin ?? bounds.min),
  );
  const hi = Math.max(
    bounds.min,
    Math.min(bounds.max, mcapMax ?? bounds.max),
  );

  const sliderPct = useMemo(() => {
    const span = Math.max(bounds.max - bounds.min, 1);
    return {
      left: ((lo - bounds.min) / span) * 100,
      width: ((hi - lo) / span) * 100,
    };
  }, [bounds.max, bounds.min, hi, lo]);

  const quarterWindow = useMemo(() => {
    if (!quarter) return null;
    return earnAnnouncementWindowForFyQuarter(quarter);
  }, [quarter]);

  return (
    <div className="concall-drift-filters">
      <div className="concall-drift-filters-row concall-drift-filters-row--primary">
        <div className="concall-sort-pills">
          <button
            type="button"
            className={`concall-pill ${sort === "all" ? "on-dark" : ""}`}
            onClick={() => onSort("all")}
          >
            ALL
          </button>
          <button
            type="button"
            className={`concall-pill concall-pill-text ${sort === "gainers" ? "on" : ""}`}
            onClick={() => onSort("gainers")}
          >
            ↑ TOP GAINERS
          </button>
          <button
            type="button"
            className={`concall-pill concall-pill-text ${sort === "losers" ? "on" : ""}`}
            onClick={() => onSort("losers")}
          >
            ↓ TOP LOSERS
          </button>
        </div>

        <span className="concall-filter-sep" aria-hidden />

        <div className="concall-date-links">
          {DATE_PRESETS.map(({ id, label }) => (
            <button
              key={id || "none"}
              type="button"
              className={`concall-date-link ${datePreset === id ? "on" : ""}`}
              onClick={() => onDatePreset(datePreset === id ? "" : id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="concall-drift-filters-row concall-drift-filters-row--secondary">
        <label className="concall-sector-field">
          <select
            value={sector}
            onChange={(e) => onSector(e.target.value)}
            aria-label="Sector"
          >
            <option value="">Sectors…</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <span className="concall-filter-sep" aria-hidden />

        <label className="concall-search-field">
          <input
            type="search"
            value={search}
            placeholder="Search ticker or company…"
            onChange={(e) => onSearch(e.target.value)}
          />
        </label>

        <div className="concall-mcap-range">
          <span className="concall-mcap-label">₹ CR</span>
          <span className="concall-mcap-values">
            {fmtCr(lo)} – {fmtCr(hi)}
          </span>
          <div className="concall-range-wrap">
            <div
              className="concall-range-fill"
              style={{
                left: `${sliderPct.left}%`,
                width: `${sliderPct.width}%`,
              }}
            />
            <input
              type="range"
              className="concall-range concall-range-lo"
              min={bounds.min}
              max={bounds.max}
              step={1}
              value={lo}
              onChange={(e) => {
                const v = Number(e.target.value);
                onMcapMin(Math.min(v, hi));
              }}
            />
            <input
              type="range"
              className="concall-range concall-range-hi"
              min={bounds.min}
              max={bounds.max}
              step={1}
              value={hi}
              onChange={(e) => {
                const v = Number(e.target.value);
                onMcapMax(Math.max(v, lo));
              }}
            />
          </div>
        </div>
      </div>

      <div className="concall-drift-filters-sub">
        <div className="concall-quarter-row">
          <span className="concall-quarter-label">Quarter</span>
          <button
            type="button"
            className={`chip concall-quarter-chip ${!quarter ? "on" : ""}`}
            onClick={() => onQuarter("")}
          >
            All
          </button>
          {quarterOptions.map((q) => (
            <button
              key={q}
              type="button"
              className={`chip concall-quarter-chip ${quarter === q ? "on" : ""}`}
              onClick={() => onQuarter(quarter === q ? "" : q)}
              title={fyQuarterExplain(q)}
            >
              {fyQuarterChipLabel(q)}
            </button>
          ))}
        </div>
        {typeof totalEvents === "number" ? (
          <span className="concall-filter-meta">
            {totalEvents.toLocaleString()} events
            {typeof withBaseline === "number"
              ? ` · ${withBaseline.toLocaleString()} with baseline`
              : null}
            {quarter
              ? ` · ${fyQuarterChipLabel(quarter)} results · filings ${quarterWindow ? `${isoDate(quarterWindow.from)} – ${isoDate(quarterWindow.to)}` : ""}`
              : null}
          </span>
        ) : null}
        {nseFeed ? <LiveNseFeedBadge status={nseFeed} compact /> : null}
      </div>

      {datePreset === "custom" ? (
        <div className="concall-custom-dates">
          <label className="field">
            <span>From</span>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => onCustomFrom(e.target.value)}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => onCustomTo(e.target.value)}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

export function defaultCustomDates(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return { from: isoDate(from), to: isoDate(to) };
}
