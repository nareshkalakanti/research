"use client";

import { useMemo, useState } from "react";
import { CompanyAboutCard } from "@/components/CompanyAboutCard";
import { QuartersRankCard } from "@/components/QuartersRankCard";
import {
  QuoteTapeCard,
  type QuoteTapeFundamentals,
} from "@/components/QuoteTapeCard";
import { SevenRuleScoreCard } from "@/components/SevenRuleScoreCard";
import { sevenRuleFromPanel } from "@/lib/seven-rule-score";
import { useExpandQuarters } from "@/lib/use-expand-quarters";

export function NapkinCompanyContext({
  ticker,
  exchange,
  price,
  companyName,
  roe,
  roce,
  fundamentals = null,
}: {
  ticker: string;
  exchange?: string | null;
  price: number | null;
  companyName?: string | null;
  roe?: number | null;
  roce?: number | null;
  /** Snapshot Revenue/EPS 5Y — shown on Tech & Val instead of price CAGR. */
  fundamentals?: QuoteTapeFundamentals | null;
}) {
  const market = (exchange || "").trim() || null;
  const qtr = useExpandQuarters(ticker, market, price, true);
  const sevenRule = useMemo(
    () =>
      qtr.panel
        ? sevenRuleFromPanel(qtr.panel, { roe: roe ?? null, roce: roce ?? null })
        : null,
    [qtr.panel, roe, roce],
  );
  const [showDetails, setShowDetails] = useState(false);

  return (
    <>
      <div className="napkin-sheet-section">
        <CompanyAboutCard
          className="napkin-about-card"
          ticker={ticker}
          market={market}
          companyName={companyName}
          active
        />
      </div>

      {sevenRule ? (
        <div className="napkin-sheet-section">
          <h2 className="napkin-block-title">7-Rule score</h2>
          <SevenRuleScoreCard result={sevenRule} compact />
        </div>
      ) : null}

      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">Quarters</h2>
        <QuartersRankCard data={qtr} price={price} />
      </div>

      <div className="napkin-sheet-section">
        <button
          type="button"
          className="napkin-details-toggle"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? "Hide Tech & Val" : "Show Tech & Val"}
        </button>
      </div>

      {showDetails ? (
        <div className="napkin-sheet-section">
          <QuoteTapeCard
            ticker={ticker}
            market={market}
            active
            fundamentals={fundamentals}
          />
        </div>
      ) : null}
    </>
  );
}
