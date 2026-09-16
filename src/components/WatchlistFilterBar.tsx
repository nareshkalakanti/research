"use client";

import {
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  type FundCountState,
  type FundFilterState,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";
import { AGE_MIN_PRESETS } from "@/lib/company-age";

function Count({ n }: { n?: number }) {
  if (n == null) return null;
  return <span className="chip-count">{n}</span>;
}

type ListsProps = {
  sme?: boolean;
  onSme?: (on: boolean) => void;
  note?: boolean;
  onNote?: (on: boolean) => void;
  /** All fund-watchlist tickers (union). */
  funds?: boolean;
  onFunds?: (on: boolean) => void;
  fundsCount?: number;
  /** Minimum company age in years; null = off. */
  ageMin?: number | null;
  onAgeMin?: (min: number | null) => void;
  smeCount?: number;
  noteCount?: number;
  /** Counts keyed by threshold (25 / 50 / 100). */
  ageCounts?: Partial<Record<number, number>>;
};

/** List tags (Funds / SME / Note / Age). Hold / Edge live on FundsFilterBar. */
export function WatchlistFilterBar({
  sme = false,
  onSme,
  note = false,
  onNote,
  funds = false,
  onFunds,
  fundsCount,
  ageMin = null,
  onAgeMin,
  smeCount,
  noteCount,
  ageCounts,
}: ListsProps) {
  const ageOn = ageMin != null;

  const filtersActive = sme || note || funds || ageOn;

  const clearFilters = () => {
    onSme?.(false);
    onNote?.(false);
    onFunds?.(false);
    onAgeMin?.(null);
  };

  return (
    <div className="filter-bar">
      <div className="filter-bar-main">
        {onFunds ? (
          <button
            type="button"
            className={`chip tag-chip tag-fund-all ${funds ? "on" : ""}`}
            onClick={() => onFunds(!funds)}
            title="All fund-watchlist holdings"
          >
            Funds
            <Count n={fundsCount} />
          </button>
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

        {onAgeMin ? (
          <span
            className="age-min-group"
            title="Company age from Groww founded year. ANDs with Funds / Signals."
          >
            <span className="age-min-label">Age ≥</span>
            {AGE_MIN_PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                className={`chip tag-chip tag-scan-age25 ${ageMin === n ? "on" : ""}`}
                onClick={() => onAgeMin(ageMin === n ? null : n)}
                title={`Founded ≥${n} years ago`}
              >
                {n}
                <Count n={ageCounts?.[n]} />
              </button>
            ))}
          </span>
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
  gov?: boolean;
  onGov?: (on: boolean) => void;
  holdCount?: number;
  edgeCount?: number;
  govCount?: number;
  funds?: FundFilterState;
  onFund?: (key: FundWatchlistKey, on: boolean) => void;
  /** Single-shot clear (avoids N partial setStates / stale chip counts). */
  onClearFunds?: () => void;
  fundKeys?: FundWatchlistKey[];
  fundCounts?: FundCountState;
};

/** Hold / Edge / Gov + ace-investor fund watchlist chips. */
export function FundsFilterBar({
  hold = false,
  onHold,
  edge = false,
  onEdge,
  gov = false,
  onGov,
  holdCount,
  distressCount,
  edgeCount,
  govCount,
  funds = {},
  onFund,
  onClearFunds,
  fundKeys,
  fundCounts = {},
}: FundsProps) {
  const visibleFundKeys = fundKeys ?? FUND_WATCHLIST_KEYS;
  const hasFunds = Boolean(onFund);
  const hasHoldEdge = Boolean(onHold || onEdge || onGov);
  if (!hasFunds && !hasHoldEdge) return null;

  const holdTitle =
    distressCount && distressCount > 0
      ? `Holdings (${holdCount ?? 0}) · ${distressCount} distress monitors`
      : "Your holdings";

  const fundActive = hasFunds && visibleFundKeys.some((k) => funds[k]);
  const filtersActive = hold || edge || gov || fundActive;

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
        {onGov ? (
          <button
            type="button"
            className={`chip tag-chip tag-gov ${gov ? "on" : ""}`}
            onClick={() => onGov(!gov)}
            title="CPSU / Gov — Maharatna, Navratna, Miniratna, Non-Ratna"
          >
            Gov
            <Count n={govCount} />
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
              onGov?.(false);
              if (onClearFunds) onClearFunds();
              else if (onFund) {
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
