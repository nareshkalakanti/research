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
  | "early"
  | "yesterday"
  | "today"
  | "tomorrow"
  | "next7"
  | "last7"
  | "custom";

type McapBounds = { min: number; max: number };

export type ConcallDriftWindowCounts = Partial<
  Record<
    "all" | "yesterday" | "today" | "early" | "last7" | "tomorrow" | "next7",
    number
  >
>;

export type ConcallDriftSortCounts = Partial<{
  all: number;
  gainers: number;
  losers: number;
}>;

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
  subSector: string;
  onSubSector: (v: string) => void;
  subSectors: string[];
  mcapMin: number | null;
  mcapMax: number | null;
  onMcapMin: (v: number) => void;
  onMcapMax: (v: number) => void;
  mcapBounds: McapBounds | null;
  search: string;
  onSearch: (q: string) => void;
  withBaseline?: number;
  totalEvents?: number;
  windowCounts?: ConcallDriftWindowCounts | null;
  sortCounts?: ConcallDriftSortCounts | null;
  loading?: boolean;
  onClear?: () => void;
  nseFeed?: NseFeedStatus;
};

const DATE_PRESETS: Array<{
  id: ConcallDriftDatePreset;
  label: string;
  title: string;
}> = [
  {
    id: "early",
    label: "Early",
    title:
      "Concall in last 2 IST days — freshest post-call moves (best for spotting early drift)",
  },
  {
    id: "yesterday",
    label: "Yesterday",
    title: "Concall announced yesterday (IST)",
  },
  {
    id: "today",
    label: "Today",
    title: "Concall announced today (IST)",
  },
  {
    id: "last7",
    label: "Last 7d",
    title: "Concall announced in the last 7 IST days",
  },
  {
    id: "tomorrow",
    label: "Tomorrow",
    title:
      "Usually empty — we only store past NSE filings, not scheduled future calls",
  },
  {
    id: "next7",
    label: "Next 7d",
    title:
      "Usually empty — we only store past NSE filings, not scheduled future calls",
  },
  { id: "custom", label: "Custom", title: "Pick a custom date range" },
];

function Count({ n, loading }: { n?: number; loading?: boolean }) {
  if (loading) {
    return (
      <span className="chip-count chip-count--busy" aria-busy="true">
        …
      </span>
    );
  }
  if (n == null) return null;
  return <span className="chip-count">{n}</span>;
}

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
  subSector,
  onSubSector,
  subSectors,
  mcapMin,
  mcapMax,
  onMcapMin,
  onMcapMax,
  mcapBounds,
  search,
  onSearch,
  withBaseline,
  totalEvents,
  windowCounts,
  sortCounts,
  loading,
  onClear,
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

  const mcapNarrowed =
    mcapBounds != null &&
    mcapMin != null &&
    mcapMax != null &&
    (mcapMin > mcapBounds.min || mcapMax < mcapBounds.max);

  const filtersActive =
    sort !== "all" ||
    Boolean(datePreset) ||
    Boolean(quarter) ||
    Boolean(sector) ||
    Boolean(subSector) ||
    Boolean(search.trim()) ||
    mcapNarrowed;

  return (
    <div className="scan-filter-stack concall-filter-stack">
      <div className="scan-filter-row">
        <span className="scan-filter-label">Move</span>
        <div className="chip-row">
          <button
            type="button"
            className={`chip tag-chip tag-concall-all ${sort === "all" ? "on" : ""}`}
            onClick={() => onSort("all")}
            title="All names with a paired concall in this window"
          >
            All
            <Count n={sortCounts?.all} loading={loading} />
          </button>
          <button
            type="button"
            className={`chip tag-chip tag-concall-gainers ${sort === "gainers" ? "on" : ""}`}
            onClick={() => onSort("gainers")}
            title="Positive Δ call — LTP above last close before concall announcement"
          >
            ↑ Gainers
            <Count n={sortCounts?.gainers} loading={loading} />
          </button>
          <button
            type="button"
            className={`chip tag-chip tag-concall-losers ${sort === "losers" ? "on" : ""}`}
            onClick={() => onSort("losers")}
            title="Negative Δ call — LTP below last close before concall announcement"
          >
            ↓ Losers
            <Count n={sortCounts?.losers} loading={loading} />
          </button>
          {filtersActive && onClear ? (
            <button
              type="button"
              className="clear-filter"
              onClick={onClear}
              title="Clear Move, When, Filter, and Quarter selections"
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      <div className="scan-filter-row">
        <span className="scan-filter-label">When</span>
        <div className="chip-row">
          {DATE_PRESETS.map(({ id, label, title }) => {
            const countKey =
              id === "custom" || id === ""
                ? null
                : (id as keyof NonNullable<typeof windowCounts>);
            const n = countKey ? windowCounts?.[countKey] : undefined;
            const emptyFuture =
              (id === "tomorrow" || id === "next7") && n === 0;
            const whenClass =
              id === "early"
                ? "tag-concall-early"
                : id === "yesterday"
                  ? "tag-concall-yesterday"
                  : id === "today"
                    ? "tag-concall-today"
                    : id === "last7"
                      ? "tag-concall-last7"
                      : id === "tomorrow"
                        ? "tag-concall-tomorrow"
                        : id === "next7"
                          ? "tag-concall-next7"
                          : id === "custom"
                            ? "tag-concall-custom"
                            : "tag-concall-when";
            return (
              <button
                key={id || "none"}
                type="button"
                className={`chip tag-chip ${whenClass} ${datePreset === id ? "on" : ""}${emptyFuture ? " is-empty" : ""}`}
                onClick={() => onDatePreset(datePreset === id ? "" : id)}
                title={title}
              >
                {label}
                {countKey ? <Count n={n} loading={loading} /> : null}
              </button>
            );
          })}
        </div>
      </div>

      {datePreset === "custom" ? (
        <div className="scan-filter-row">
          <span className="scan-filter-label">Dates</span>
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
        </div>
      ) : null}

      <div className="scan-filter-row">
        <span className="scan-filter-label">Filter</span>
        <div className="concall-filter-tools">
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

          <label className="concall-sector-field">
            <select
              value={subSector}
              onChange={(e) => onSubSector(e.target.value)}
              aria-label="Sub-sector"
            >
              <option value="">Sub-sectors…</option>
              {subSectors.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

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
      </div>

      <div className="scan-filter-row">
        <span className="scan-filter-label">Quarter</span>
        <div className="concall-quarter-row">
          <button
            type="button"
            className={`chip concall-quarter-chip tag-concall-q ${!quarter ? "on" : ""}`}
            onClick={() => onQuarter("")}
          >
            All
          </button>
          {quarterOptions.map((q, i) => (
            <button
              key={q}
              type="button"
              className={`chip concall-quarter-chip tag-concall-q tag-concall-q-${(i % 4) + 1} ${quarter === q ? "on" : ""}`}
              onClick={() => onQuarter(quarter === q ? "" : q)}
              title={fyQuarterExplain(q)}
            >
              {fyQuarterChipLabel(q)}
            </button>
          ))}
          {typeof totalEvents === "number" ? (
            <span className="concall-filter-meta">
              {totalEvents.toLocaleString()} events
              {typeof withBaseline === "number"
                ? ` · ${withBaseline.toLocaleString()} with call baseline`
                : null}
              {quarter
                ? ` · ${fyQuarterChipLabel(quarter)} · filings ${quarterWindow ? `${isoDate(quarterWindow.from)} – ${isoDate(quarterWindow.to)}` : ""}`
                : null}
            </span>
          ) : null}
          {nseFeed ? <LiveNseFeedBadge status={nseFeed} compact /> : null}
        </div>
      </div>
    </div>
  );
}

export function defaultCustomDates(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return { from: isoDate(from), to: isoDate(to) };
}
