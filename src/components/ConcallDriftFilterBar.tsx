"use client";

import { useMemo } from "react";
import {
  earnAnnouncementWindowForFyQuarter,
  fyQuarterChipLabel,
  fyQuarterExplain,
  isoDate,
} from "@/lib/strategy/concall-drift-quarters";
import { istTodayParts, shiftIstCivilDay } from "@/lib/nse-time";
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
  shownCount?: number;
  windowCounts?: ConcallDriftWindowCounts | null;
  sortCounts?: ConcallDriftSortCounts | null;
  loading?: boolean;
  onClear?: () => void;
  nseFeed?: NseFeedStatus;
  bseFeed?: NseFeedStatus;
  density: "comfy" | "compact";
  onDensity: (d: "comfy" | "compact") => void;
  onExportCsv?: () => void;
};

const DATE_PRESETS: Array<{
  id: ConcallDriftDatePreset;
  label: string;
  title: string;
}> = [
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
    id: "tomorrow",
    label: "Tomorrow",
    title:
      "Usually empty — we only store past NSE filings, not scheduled future calls",
  },
  {
    id: "next7",
    label: "Next 7 days",
    title:
      "Usually empty — we only store past NSE filings, not scheduled future calls",
  },
  {
    id: "last7",
    label: "Last 7 days",
    title: "Concall announced in the last 7 IST days",
  },
  { id: "custom", label: "Custom", title: "Pick a custom date range" },
];

function fmtCr(n: number): string {
  const rounded = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${rounded.toLocaleString("en-IN")} Cr`;
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
  subSector: _subSector,
  onSubSector: _onSubSector,
  subSectors: _subSectors,
  mcapMin,
  mcapMax,
  onMcapMin,
  onMcapMax,
  mcapBounds,
  search,
  onSearch,
  withBaseline,
  totalEvents,
  shownCount,
  windowCounts,
  sortCounts: _sortCounts,
  loading,
  onClear,
  nseFeed,
  bseFeed,
  density,
  onDensity,
  onExportCsv,
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
    Boolean(search.trim()) ||
    mcapNarrowed;

  const feedLive = Boolean(nseFeed?.live || bseFeed?.live);
  const feedLabel = feedLive ? "Feed live" : "Feed stale";

  return (
    <div className="pcd-chrome">
      <div className="pcd-topbar">
        <label className="pcd-quarter-pill">
          <span className="pcd-sr">Quarter</span>
          <select
            value={quarter}
            onChange={(e) => onQuarter(e.target.value)}
            title={quarter ? fyQuarterExplain(quarter) : "All quarters"}
          >
            <option value="">All quarters</option>
            {quarterOptions.map((q) => (
              <option key={q} value={q}>
                {fyQuarterChipLabel(q)}
              </option>
            ))}
          </select>
        </label>

        <div className="pcd-density" role="group" aria-label="Row density">
          <button
            type="button"
            className={density === "comfy" ? "on" : ""}
            onClick={() => onDensity("comfy")}
          >
            Comfy
          </button>
          <button
            type="button"
            className={density === "compact" ? "on" : ""}
            onClick={() => onDensity("compact")}
          >
            Compact
          </button>
        </div>

        {onExportCsv ? (
          <button type="button" className="pcd-ghost-btn" onClick={onExportCsv}>
            CSV
          </button>
        ) : null}

        <div className="pcd-status">
          <span className={feedLive ? "pcd-feed is-live" : "pcd-feed is-stale"}>
            <span className="pcd-feed-dot" aria-hidden />
            {feedLabel}
          </span>
          {nseFeed ? (
            <span className="pcd-exch" title={nseFeed.detail}>
              NSE {nseFeed.live ? "on" : "off"}
            </span>
          ) : null}
          {bseFeed ? (
            <span className="pcd-exch" title={bseFeed.detail}>
              BSE {bseFeed.live ? "on" : "off"}
            </span>
          ) : null}
        </div>
      </div>

      <div className="pcd-toolbar">
        <div className="pcd-sort">
          <button
            type="button"
            className={sort === "all" ? "on" : ""}
            onClick={() => onSort("all")}
          >
            All
          </button>
          <button
            type="button"
            className={sort === "gainers" ? "on" : ""}
            onClick={() => onSort("gainers")}
            title="Positive Δ earn"
          >
            + Top gainers
          </button>
          <button
            type="button"
            className={sort === "losers" ? "on" : ""}
            onClick={() => onSort("losers")}
            title="Negative Δ earn"
          >
            + Top losers
          </button>
        </div>

        <div className="pcd-presets">
          {DATE_PRESETS.map(({ id, label, title }) => {
            const countKey =
              id === "custom" || id === ""
                ? null
                : (id as keyof NonNullable<typeof windowCounts>);
            const n = countKey ? windowCounts?.[countKey] : undefined;
            return (
              <button
                key={id}
                type="button"
                className={datePreset === id ? "on" : ""}
                onClick={() => onDatePreset(datePreset === id ? "" : id)}
                title={title}
              >
                {label}
                {n != null && !loading ? (
                  <span className="pcd-preset-n">{n}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        <label className="pcd-sector">
          <span className="pcd-sr">Sector</span>
          <select
            value={sector}
            onChange={(e) => onSector(e.target.value)}
          >
            <option value="">Sectors…</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <div className="pcd-mcap">
          <div className="pcd-mcap-head">
            <span className="pcd-mcap-lab">MCap</span>
            <span className="pcd-mcap-vals">
              {fmtCr(lo)} – {fmtCr(hi)}
            </span>
          </div>
          <div className="pcd-range-wrap">
            <div
              className="pcd-range-fill"
              style={{
                left: `${sliderPct.left}%`,
                width: `${sliderPct.width}%`,
              }}
            />
            <input
              type="range"
              className="pcd-range pcd-range-lo"
              min={bounds.min}
              max={bounds.max}
              step={1}
              value={lo}
              aria-label="Minimum market cap"
              onChange={(e) => onMcapMin(Math.min(Number(e.target.value), hi))}
            />
            <input
              type="range"
              className="pcd-range pcd-range-hi"
              min={bounds.min}
              max={bounds.max}
              step={1}
              value={hi}
              aria-label="Maximum market cap"
              onChange={(e) => onMcapMax(Math.max(Number(e.target.value), lo))}
            />
          </div>
        </div>

        <label className="pcd-search">
          <span className="pcd-sr">Search</span>
          <input
            type="search"
            value={search}
            placeholder="Search ticker or company…"
            onChange={(e) => onSearch(e.target.value)}
          />
        </label>

        {filtersActive && onClear ? (
          <button type="button" className="pcd-clear" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>

      {datePreset === "custom" ? (
        <div className="pcd-custom-dates">
          <label>
            From
            <input
              type="date"
              value={customFrom}
              onChange={(e) => onCustomFrom(e.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={customTo}
              onChange={(e) => onCustomTo(e.target.value)}
            />
          </label>
        </div>
      ) : null}

      <div className="pcd-meta">
        <span>
          {quarter && quarterWindow ? (
            <>
              Events · {isoDate(quarterWindow.from)} —{" "}
              {isoDate(quarterWindow.to)}
            </>
          ) : datePreset === "custom" && customFrom && customTo ? (
            <>
              Events · {customFrom} — {customTo}
            </>
          ) : (
            <>Events · all windows</>
          )}
        </span>
        <span>
          {typeof shownCount === "number" && typeof totalEvents === "number"
            ? `${shownCount.toLocaleString("en-IN")} of ${totalEvents.toLocaleString("en-IN")} stocks`
            : typeof totalEvents === "number"
              ? `${totalEvents.toLocaleString("en-IN")} stocks`
              : null}
          {typeof withBaseline === "number"
            ? ` · ${withBaseline.toLocaleString("en-IN")} with baseline`
            : null}
        </span>
      </div>
    </div>
  );
}

export function defaultCustomDates(): { from: string; to: string } {
  const toDay = istTodayParts();
  const fromDay = shiftIstCivilDay(toDay, -30);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    from: `${fromDay.year}-${pad(fromDay.month)}-${pad(fromDay.day)}`,
    to: `${toDay.year}-${pad(toDay.month)}-${pad(toDay.day)}`,
  };
}
