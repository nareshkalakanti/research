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
import { AGE_MIN_PRESETS } from "@/lib/company-age";
import { useEffect, useState } from "react";

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
  /** Minimum company age in years; null = off. */
  ageMin?: number | null;
  onAgeMin?: (min: number | null) => void;
  smeCount?: number;
  noteCount?: number;
  /** Counts keyed by threshold (25 / 50 / 100 / custom). */
  ageCounts?: Partial<Record<number, number>>;
  capCounts?: Partial<Record<CapFilter, number>>;
  allCount?: number;
};

/** Cap + list tags (SME / Note / Age). Hold / Edge live on FundsFilterBar. */
export function WatchlistFilterBar({
  cap,
  onCap,
  sme = false,
  onSme,
  note = false,
  onNote,
  ageMin = null,
  onAgeMin,
  smeCount,
  noteCount,
  ageCounts,
  capCounts,
  allCount,
}: ListsProps) {
  const ageOn = ageMin != null;
  const isCustom =
    ageOn && !(AGE_MIN_PRESETS as readonly number[]).includes(ageMin);
  const [draft, setDraft] = useState(String(ageMin ?? 25));

  useEffect(() => {
    if (ageMin != null) setDraft(String(ageMin));
  }, [ageMin]);

  const filtersActive =
    (cap != null && cap !== "All") || sme || note || ageOn;

  const clearFilters = () => {
    onCap?.("All");
    onSme?.(false);
    onNote?.(false);
    onAgeMin?.(null);
  };

  const applyCustom = () => {
    const n = Math.floor(Number(draft));
    if (!Number.isFinite(n) || n < 1 || n > 200) {
      setDraft(String(ageMin ?? 25));
      return;
    }
    onAgeMin?.(n);
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
            <label
              className={`chip tag-chip tag-scan-age25 age-min-edit ${isCustom ? "on" : ""}`}
            >
              <input
                type="number"
                min={1}
                max={200}
                inputMode="numeric"
                className="age-min-input"
                value={draft}
                aria-label="Custom minimum age"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={applyCustom}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === "Escape") {
                    setDraft(String(ageMin ?? 25));
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
              {isCustom ? <Count n={ageCounts?.[ageMin]} /> : null}
            </label>
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
  holdCount?: number;
  edgeCount?: number;
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
  holdCount,
  distressCount,
  edgeCount,
  funds = {},
  onFund,
  fundKeys,
  fundCounts = {},
}: FundsProps) {
  const visibleFundKeys = fundKeys ?? FUND_WATCHLIST_KEYS;
  const hasFunds = Boolean(onFund);
  const hasHoldEdge = Boolean(onHold || onEdge);
  if (!hasFunds && !hasHoldEdge) return null;

  const holdTitle =
    distressCount && distressCount > 0
      ? `Holdings (${holdCount ?? 0}) · ${distressCount} distress monitors`
      : "Your holdings";

  const fundActive = hasFunds && visibleFundKeys.some((k) => funds[k]);
  const filtersActive = hold || edge || fundActive;

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
