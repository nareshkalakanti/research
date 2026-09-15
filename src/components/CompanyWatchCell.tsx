"use client";

import {
  bseScripCodeFromTicker,
  tradingviewUrl,
} from "@/lib/links";
import { WatchButton } from "@/components/WatchButton";

function tvMarket(
  ticker: string,
  market?: string | null,
): string {
  const idx = (market || "").trim().toLowerCase();
  if (idx.includes("bse") || /^BSE/i.test(ticker)) return "BSE";
  if (idx === "sme" || idx.includes("sme")) return "NSE SME";
  return "NSE";
}

/** Watch chip + company name → TradingView (shared across IQ list rows). */
export function CompanyWatchCell({
  ticker,
  company,
  market,
}: {
  ticker: string | null | undefined;
  company: string | null | undefined;
  market?: string | null;
}) {
  const label = (company || ticker || "—").trim() || "—";
  const sym = (ticker || "").trim().toUpperCase();
  if (!sym || sym === "—") {
    return <div className="miq-co-name">{label}</div>;
  }
  const scrip = bseScripCodeFromTicker(sym);
  const mk = tvMarket(sym, market);
  const href = tradingviewUrl(sym, mk);
  const exchange =
    scrip || mk.toUpperCase().includes("BSE") ? "BSE" : "NSE";
  const title = scrip
    ? `${label} — BSE India (scrip ${scrip})`
    : `${label} — TradingView`;

  return (
    <div className="company-watch-cell">
      <WatchButton ticker={sym} />
      <div className="company-watch-name">
        <a
          className="miq-co-name"
          href={href}
          target="_blank"
          rel="noreferrer"
          title={title}
        >
          {label}
        </a>
        <span
          className={`exch-chip exch-${exchange.toLowerCase()}`}
          title={scrip ? `BSE scrip ${scrip}` : exchange}
        >
          {exchange}
        </span>
      </div>
    </div>
  );
}
