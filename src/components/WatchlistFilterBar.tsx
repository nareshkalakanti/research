"use client";

import {
  CapMarketFilters,
  type CapFilter,
} from "@/components/CapMarketFilters";
import {
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  type FundCountState,
  type FundFilterState,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";

function Count({ n }: { n?: number }) {
  if (n == null) return null;
  return <span className="chip-count">{n}</span>;
}

type ListsProps = {
  cap?: CapFilter;
  onCap?: (cap: CapFilter) => void;
  sme?: boolean;
  onSme?: (on: boolean) => void;
  note?: boolean;
  onNote?: (on: boolean) => void;
  smeCount?: number;
  noteCount?: number;
  capCounts?: Partial<Record<CapFilter, number>>;
  allCount?: number;
};

/** Cap + list tags (SME / Note). Hold / Edge live on FundsFilterBar. */
export function WatchlistFilterBar({
  cap,
  onCap,
  sme = false,
  onSme,
  note = false,
  onNote,
  smeCount,
  noteCount,
  capCounts,
  allCount,
}: ListsProps) {
  const filtersActive =
    (cap != null && cap !== "All") ||
    sme ||
    note;

  const clearFilters = () => {
    onCap?.("All");
    onSme?.(false);
    onNote?.(false);
  };

  return (
    <div className="filter-bar">
      <div className="filter-bar-main">
        {onCap && cap != null ? (
          <>
            <CapMarketFilters
              cap={cap}
              onCap={onCap}
              inline
              capCounts={capCounts}
              allCount={allCount}
            />
            <span className="filter-sep" aria-hidden />
          </>
        ) : null}

        {onSme ? (
          <button
            type="button"
            className={`chip tag-chip tag-mkt-sme ${sme ? "on" : ""}`}
            onClick={() => onSme(!sme)}
            title="SME listings (NSE SME + BSE SME)"
          >
            SME
            <Count n={smeCount} />
          </button>
        ) : null}
        {onNote ? (
          <button
            type="button"
            className={`chip tag-chip tag-note ${note ? "on" : ""}`}
            onClick={() => onNote(!note)}
            title="Stocks with a saved research note"
          >
            Note
            <Count n={noteCount} />
          </button>
        ) : null}

        {filtersActive ? (
          <button
            type="button"
            className="clear-filter"
            onClick={clearFilters}
            title="Reset list filters"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

type FundsProps = {
  hold?: boolean;
  onHold?: (on: boolean) => void;
  distressCount?: number;
  edge?: boolean;
  onEdge?: (on: boolean) => void;
  quality?: boolean;
  onQuality?: (on: boolean) => void;
  holdCount?: number;
  edgeCount?: number;
  qualityCount?: number;
  funds?: FundFilterState;
  onFund?: (key: FundWatchlistKey, on: boolean) => void;
  fundKeys?: FundWatchlistKey[];
  fundCounts?: FundCountState;
};

/** Hold / Edge + ace-investor fund watchlist chips. */
export function FundsFilterBar({
  hold = false,
  onHold,
  edge = false,
  onEdge,
  quality = false,
  onQuality,
  holdCount,
  distressCount,
  edgeCount,
  qualityCount,
  funds = {},
  onFund,
  fundKeys,
  fundCounts = {},
}: FundsProps) {
  const visibleFundKeys = fundKeys ?? FUND_WATCHLIST_KEYS;
  const hasFunds = Boolean(onFund);
  const hasHoldEdge = Boolean(onHold || onEdge || onQuality);
  if (!hasFunds && !hasHoldEdge) return null;

  const holdTitle =
    distressCount && distressCount > 0
      ? `Holdings (${holdCount ?? 0}) · ${distressCount} distress monitors`
      : "Your holdings";

  const fundActive = hasFunds && visibleFundKeys.some((k) => funds[k]);
  const filtersActive = hold || edge || quality || fundActive;

  return (
    <div className="filter-bar">
      <div className="filter-bar-main">
        {onHold ? (
          <button
            type="button"
            className={`chip tag-chip tag-hold ${hold ? "on" : ""}`}
            onClick={() => onHold(!hold)}
            title={holdTitle}
          >
            Hold
            <Count n={holdCount} />
          </button>
        ) : null}
        {onEdge ? (
          <button
            type="button"
            className={`chip tag-chip tag-edge ${edge ? "on" : ""}`}
            onClick={() => onEdge(!edge)}
            title="Early Edge watchlist"
          >
            Edge
            <Count n={edgeCount} />
          </button>
        ) : null}
        {onQuality ? (
          <button
            type="button"
            className={`chip tag-chip tag-quality ${quality ? "on" : ""}`}
            onClick={() => onQuality(!quality)}
            title="Screener quality screen: Sales/Profit growth, ROE/ROCE >15, D/E <0.5, OPM >10%, promoters, institutional, mcap <10k Cr"
          >
            Quality
            <Count n={qualityCount} />
          </button>
        ) : null}
        {hasHoldEdge && hasFunds ? (
          <span className="filter-sep" aria-hidden />
        ) : null}
        {hasFunds
          ? visibleFundKeys.map((key) => (
              <button
                key={key}
                type="button"
                className={`chip tag-chip tag-${key} ${funds[key] ? "on" : ""}`}
                onClick={() => onFund!(key, !funds[key])}
                title={`${FUND_WATCHLIST_LABELS[key]} fund watchlist`}
              >
                {FUND_WATCHLIST_LABELS[key]}
                <Count n={fundCounts[key]} />
              </button>
            ))
          : null}
        {filtersActive ? (
          <button
            type="button"
            className="clear-filter"
            onClick={() => {
              onHold?.(false);
              onEdge?.(false);
              onQuality?.(false);
              if (onFund) {
                for (const key of visibleFundKeys) onFund(key, false);
              }
            }}
            title="Clear fund filters"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

export { clearFundFilters } from "@/lib/fund-watchlist-meta";
