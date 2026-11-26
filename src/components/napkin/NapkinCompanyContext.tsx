"use client";

import { useMemo } from "react";
import { CompanyAboutCard } from "@/components/CompanyAboutCard";
import { NapkinFundHolders } from "@/components/napkin/NapkinFundHolders";
import { NapkinScorecard } from "@/components/napkin/NapkinScorecard";
import { NapkinPortfolioEval } from "@/components/napkin/NapkinPortfolioEval";
import { NapkinPriceMaStrip } from "@/components/napkin/NapkinPriceMaStrip";
import { useQualityFlags } from "@/components/napkin/NapkinQualityFlags";
import { quarterRankFromPanel } from "@/lib/quarter-rank";
import { sevenRuleFromPanel } from "@/lib/seven-rule-score";
import type { ExpandQuarterData } from "@/lib/use-expand-quarters";

export function NapkinCompanyContext({
  ticker,
  exchange,
  price,
  companyName,
  roe,
  roce,
  qtr,
}: {
  /** Quarter data loaded once by the panel (shared with the P/E strip). */
  qtr: ExpandQuarterData;
  ticker: string;
  exchange?: string | null;
  price: number | null;
  companyName?: string | null;
  roe?: number | null;
  roce?: number | null;
}) {
  const market = (exchange || "").trim() || null;
  const sevenRule = useMemo(
    () =>
      qtr.panel
        ? sevenRuleFromPanel(qtr.panel, { roe: roe ?? null, roce: roce ?? null })
        : null,
    [qtr.panel, roe, roce],
  );

  const qrank = useMemo(
    () => (qtr.panel?.labels?.length ? quarterRankFromPanel(qtr.panel, qtr.yoy) : null),
    [qtr.panel, qtr.yoy],
  );
  const quality = useQualityFlags(ticker);

  return (
    <>
      <div className="napkin-sheet-section napkin-about-row">
        <CompanyAboutCard
          className="napkin-about-card"
          ticker={ticker}
          market={market}
          companyName={companyName}
          active
        />
        <NapkinPriceMaStrip
          ticker={ticker}
          market={market}
          priceFallback={price}
        />
      </div>

      <NapkinFundHolders ticker={ticker} />

      <NapkinScorecard
        sevenRule={sevenRule}
        qrank={qrank}
        qtr={qtr}
        price={price}
        quality={quality.q}
        qualityReady={quality.ready}
        ticker={ticker}
        market={market}
      />

      <NapkinPortfolioEval ticker={ticker} />
    </>
  );
}
