"use client";

import { tradingviewUrl } from "@/lib/links";
import { WatchButton } from "@/components/WatchButton";

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
  const idx = (market || "").trim().toLowerCase();
  const mk =
    idx === "sme" || idx.includes("bse")
      ? idx.includes("bse")
        ? "BSE"
        : "NSE SME"
      : "NSE";
  const skipTv = /^BSE\d{5,6}$/i.test(sym) || /^\d{5,6}$/.test(sym);

  return (
    <div className="company-watch-cell">
      <WatchButton ticker={sym} />
      <div className="company-watch-name">
        {skipTv ? (
          <div className="miq-co-name">{label}</div>
        ) : (
          <a
            className="miq-co-name"
            href={tradingviewUrl(sym, mk)}
            target="_blank"
            rel="noreferrer"
            title={`${label} — TradingView`}
          >
            {label}
          </a>
        )}
      </div>
    </div>
  );
}
