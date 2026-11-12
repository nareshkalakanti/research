"use client";

import { useMemo } from "react";
import { CompanyAboutCard } from "@/components/CompanyAboutCard";
import { QuartersRankCard } from "@/components/QuartersRankCard";
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
}: {
  ticker: string;
  exchange?: string | null;
  price: number | null;
  companyName?: string | null;
  roe?: number | null;
  roce?: number | null;
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
          <h2 className="napkin-block-title">Momentum</h2>
          <SevenRuleScoreCard result={sevenRule} compact />
        </div>
      ) : null}

      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">Quarters</h2>
        <QuartersRankCard data={qtr} price={price} />
      </div>
    </>
  );
}
