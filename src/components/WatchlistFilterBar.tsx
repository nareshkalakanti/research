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
  /** Subset of fund chips to show (default: all). */
  fundKeys?: FundWatchlistKey[];
  sme?: boolean;
  onSme?: (on: boolean) => void;
  note?: boolean;
  onNote?: (on: boolean) => void;
  holdCount?: number;
  edgeCount?: number;
  fundCounts?: FundCountState;
  smeCount?: number;
  noteCount?: number;
  capCounts?: Partial<Record<CapFilter, number>>;
  allCount?: number;
  /** Buyback window currently open (Strategy tab). */
  openOnly?: boolean;
  onOpenOnly?: (on: boolean) => void;
  openCount?: number;
  tenderOnly?: boolean;
  onTenderOnly?: (on: boolean) => void;
  tenderCount?: number;
  spread8Only?: boolean;
  onSpread8Only?: (on: boolean) => void;
  spread8Count?: number;
  buyableOnly?: boolean;
  onBuyableOnly?: (on: boolean) => void;
  buyCount?: number;
  liveTender8Only?: boolean;
  onLiveTender8Only?: (on: boolean) => void;
  liveTender8Count?: number;
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
  fundKeys,
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
  capCounts,
  allCount,
  openOnly = false,
  onOpenOnly,
  openCount,
  tenderOnly = false,
  onTenderOnly,
  tenderCount,
  spread8Only = false,
  onSpread8Only,
  spread8Count,
  buyableOnly = false,
  onBuyableOnly,
  buyCount,
  liveTender8Only = false,
  onLiveTender8Only,
  liveTender8Count,
}: Props) {
  const holdTitle =
    distressCount && distressCount > 0
      ? `Holdings (${holdCount ?? 0}) · ${distressCount} distress monitors`
      : "Your holdings";

  const visibleFundKeys = fundKeys ?? FUND_WATCHLIST_KEYS;

  const filtersActive =
    (cap != null && cap !== "All") ||
    hold ||
    edge ||
    visibleFundKeys.some((k) => funds[k]) ||
    sme ||
    note ||
    openOnly ||
    tenderOnly ||
    spread8Only ||
    buyableOnly ||
    liveTender8Only;

  const clearFilters = () => {
    onCap?.("All");
    onHold?.(false);
    onEdge?.(false);
    if (onFund) {
      for (const key of visibleFundKeys) onFund(key, false);
    }
    onSme?.(false);
    onNote?.(false);
    onOpenOnly?.(false);
    onTenderOnly?.(false);
    onSpread8Only?.(false);
    onBuyableOnly?.(false);
    onLiveTender8Only?.(false);
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
          ? visibleFundKeys.map((key) => (
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
        {onLiveTender8Only ? (
          <button
            type="button"
            className={`chip tag-chip tag-live8 ${liveTender8Only ? "on" : ""}`}
            onClick={() => onLiveTender8Only(!liveTender8Only)}
            title="Live tender buyback — announced or open, max ₹ ≥8% above CMP, filing within last 120 days"
          >
            Live ≥8%
            <Count n={liveTender8Count} />
          </button>
        ) : null}
        {onBuyableOnly ? (
          <button
            type="button"
            className={`chip tag-chip tag-buy ${buyableOnly ? "on" : ""}`}
            onClick={() => onBuyableOnly(!buyableOnly)}
            title="Tender buyback with max price — status announced (buy before record date) or open (tender live)"
          >
            Can buy
            <Count n={buyCount} />
          </button>
        ) : null}
        {onOpenOnly ? (
          <button
            type="button"
            className={`chip tag-chip tag-open ${openOnly ? "on" : ""}`}
            onClick={() => onOpenOnly(!openOnly)}
            title="Buyback window currently open"
          >
            Open
            <Count n={openCount} />
          </button>
        ) : null}
        {onTenderOnly ? (
          <button
            type="button"
            className={`chip tag-chip tag-tender ${tenderOnly ? "on" : ""}`}
            onClick={() => onTenderOnly(!tenderOnly)}
            title="Tender offer buybacks (excludes open-market route)"
          >
            Tender
            <Count n={tenderCount} />
          </button>
        ) : null}
        {onSpread8Only ? (
          <button
            type="button"
            className={`chip tag-chip tag-spread8 ${spread8Only ? "on" : ""}`}
            onClick={() => onSpread8Only(!spread8Only)}
            title="Max buyback price at least 8% above CMP"
          >
            ≥8%
            <Count n={spread8Count} />
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

export { clearFundFilters } from "@/lib/fund-watchlist-meta";
