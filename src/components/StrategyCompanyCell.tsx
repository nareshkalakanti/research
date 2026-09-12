"use client";

import { WatchButton } from "@/components/WatchButton";

type Props = {
  name: string;
  ticker: string;
  open: boolean;
  onToggle: () => void;
};

/** Ticker-only expand trigger — full name in title + expand panel. */
export function StrategyCompanyCell({ name, ticker, open, onToggle }: Props) {
  return (
    <div className="company-watch-row strategy-watch-row">
      <WatchButton ticker={ticker} />
      <button
        type="button"
        className="strategy-ticker-cell"
        onClick={onToggle}
        title={name}
      >
        <span className="strategy-row-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="ticker">{ticker}</span>
      </button>
    </div>
  );
}
