"use client";

import {
  CapMarketFilters,
  type CapFilter,
} from "@/components/CapMarketFilters";

type Props = {
  cap?: CapFilter;
  onCap?: (cap: CapFilter) => void;
  hold?: boolean;
  onHold?: (on: boolean) => void;
  distressCount?: number;
  edge?: boolean;
  onEdge?: (on: boolean) => void;
  niveshaay?: boolean;
  onNiveshaay?: (on: boolean) => void;
  negen?: boolean;
  onNegen?: (on: boolean) => void;
  sme?: boolean;
  onSme?: (on: boolean) => void;
  note?: boolean;
  onNote?: (on: boolean) => void;
  green?: boolean;
  onGreen?: (on: boolean) => void;
  holdCount?: number;
  edgeCount?: number;
  niveshaayCount?: number;
  negenCount?: number;
  smeCount?: number;
  noteCount?: number;
  greenCount?: number;
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
  niveshaay = false,
  onNiveshaay,
  negen = false,
  onNegen,
  sme = false,
  onSme,
  note = false,
  onNote,
  green = false,
  onGreen,
  holdCount,
  distressCount,
  edgeCount,
  niveshaayCount,
  negenCount,
  smeCount,
  noteCount,
  greenCount,
}: Props) {
  const holdTitle =
    distressCount && distressCount > 0
      ? `Holdings (${holdCount ?? 0}) · ${distressCount} distress monitors`
      : "Your holdings";

  const filtersActive =
    (cap != null && cap !== "All") ||
    hold ||
    edge ||
    niveshaay ||
    negen ||
    sme ||
    note ||
    green;

  const clearFilters = () => {
    onCap?.("All");
    onHold?.(false);
    onEdge?.(false);
    onNiveshaay?.(false);
    onNegen?.(false);
    onSme?.(false);
    onNote?.(false);
    onGreen?.(false);
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
        {onNiveshaay ? (
          <button
            type="button"
            className={`chip tag-chip tag-niveshaay ${niveshaay ? "on" : ""}`}
            onClick={() => onNiveshaay(!niveshaay)}
            title="Niveshaay fund watchlist"
          >
            Niveshaay
            <Count n={niveshaayCount} />
          </button>
        ) : null}
        {onNegen ? (
          <button
            type="button"
            className={`chip tag-chip tag-negen ${negen ? "on" : ""}`}
            onClick={() => onNegen(!negen)}
            title="Negen fund watchlist"
          >
            Negen
            <Count n={negenCount} />
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

        {onGreen ? (
          <button
            type="button"
            className={`chip tag-chip tag-green ${green ? "on" : ""}`}
            onClick={() => onGreen(!green)}
            title="Fwd PE ≤20 and EPS & Sales YoY both positive (cached metrics)"
          >
            <span className="tag-green-dots" aria-hidden>
              <span /> <span /> <span />
            </span>
            Green
            <Count n={greenCount} />
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
