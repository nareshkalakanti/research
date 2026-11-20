"use client";

import { napkinUrl, tradingviewUrl } from "@/lib/links";

/** TV (TradingView chart) + NP (Napkin) chips — both open in a new tab. */
export function StockLinks({ ticker, market }: { ticker: string; market?: string | null }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <>
      <a className="np-chip" href={tradingviewUrl(ticker, market ?? "NSE")} target="_blank" rel="noopener noreferrer" title={`${ticker} on TradingView`} onClick={stop}>
        TV
      </a>
      <a className="np-chip" href={napkinUrl(ticker)} target="_blank" rel="noopener noreferrer" title={`Open ${ticker} in Napkin`} onClick={stop}>
        NP
      </a>
    </>
  );
}
