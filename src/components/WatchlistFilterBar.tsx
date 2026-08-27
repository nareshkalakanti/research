"use client";

import {
  CapMarketFilters,
  type CapFilter,
} from "@/components/CapMarketFilters";
import {
  anyFundFilterActive,
  clearFundFilters,
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  type FundCountState,
  type FundFilterState,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";

type Props = {
  cap?: CapFilter;
  onCap?: (cap: CapFilter) => void;
  hold?: boolean;
  onHold?: (on: boolean) => void;
  distressCount?: number;
  edge?: boolean;
  onEdge?: (on: boolean) => void;
  /** Per-investor fund watchlist filters (Trendlyne books). */
  funds?: FundFilterState;
  onFund?: (key: FundWatchlistKey, on: boolean) => void;
  sme?: boolean;
  onSme?: (on: boolean) => void;
  note?: boolean;
  onNote?: (on: boolean) => void;
  holdCount?: number;
  edgeCount?: number;
  fundCounts?: FundCountState;
  smeCount?: number;
  noteCount?: number;
};

function Count({ n }: { n?: number }) {
  if (n == null) return null;
  return <span className="chip-count">{n}</span>;
}

/** Cap + watchlist tag chips — no BB/TQ/EMA scan. */
export function WatchlistFilterBar({
  cap,
  onCap,
  hold = false,
  onHold,
  edge = false,
  onEdge,
  funds = {},
  onFund,
  sme = false,
  onSme,
  note = false,
  onNote,
  holdCount,
  distressCount,
  edgeCount,
  fundCounts = {},
  smeCount,
  noteCount,
}: Props) {
  const holdTitle =
    distressCount && distressCount > 0
      ? `Holdings (${holdCount ?? 0}) · ${distressCount} distress monitors`
      : "Your holdings";

  const filtersActive =
    (cap != null && cap !== "All") ||
    hold ||
    edge ||
    anyFundFilterActive(funds) ||
    sme ||
    note;

  const clearFilters = () => {
    onCap?.("All");
    onHold?.(false);
    onEdge?.(false);
    if (onFund) {
      for (const key of FUND_WATCHLIST_KEYS) onFund(key, false);
    }
    onSme?.(false);
    onNote?.(false);
  };

  return (
    <div className="filter-bar">
      <div className="filter-bar-main">
        {onCap && cap != null ? (
          <>
            <CapMarketFilters cap={cap} onCap={onCap} inline />
            <span className="filter-sep" aria-hidden />
          </>
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
        {onFund
          ? FUND_WATCHLIST_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                className={`chip tag-chip tag-${key} ${funds[key] ? "on" : ""}`}
                onClick={() => onFund(key, !funds[key])}
                title={`${FUND_WATCHLIST_LABELS[key]} fund watchlist`}
              >
                {FUND_WATCHLIST_LABELS[key]}
                <Count n={fundCounts[key]} />
              </button>
            ))
          : null}
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

        {filtersActive ? (
          <button
            type="button"
            className="clear-filter"
            onClick={clearFilters}
            title="Reset cap and tag filters"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

export { clearFundFilters };
