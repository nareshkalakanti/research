"use client";

import { useMemo } from "react";
import { CompanyAboutCard } from "@/components/CompanyAboutCard";
import { NapkinChecklistCard } from "@/components/napkin/NapkinChecklistCard";
import { NapkinPerformance } from "@/components/napkin/NapkinPerformance";
import { QuartersRankCard } from "@/components/QuartersRankCard";
import { SevenRuleScoreCard } from "@/components/SevenRuleScoreCard";
import {
  napkinGrowth,
  patTtmGrowthFromQuarters,
} from "@/lib/napkin/growth";
import type { NapkinPerformance as Perf } from "@/lib/napkin/performance";
import { sevenRuleFromPanel } from "@/lib/seven-rule-score";
import { useExpandQuarters } from "@/lib/use-expand-quarters";

function growthInputsFromChecks(growth: Perf | null | undefined): {
  revenue_yoy: number | null;
  eps_yoy: number | null;
  eps_cagr_3y: number | null;
} {
  const byId = new Map((growth?.checks ?? []).map((c) => [c.id, c.value]));
  return {
    revenue_yoy: byId.get("revenue_yoy") ?? null,
    eps_yoy: byId.get("eps_yoy") ?? null,
    eps_cagr_3y: byId.get("eps_cagr_3y") ?? null,
  };
}

export function NapkinCompanyContext({
  ticker,
  exchange,
  price,
  companyName,
  roe,
  roce,
  performance,
  growth,
}: {
  ticker: string;
  exchange?: string | null;
  price: number | null;
  companyName?: string | null;
  roe?: number | null;
  roce?: number | null;
  performance?: Perf | null;
  growth?: Perf | null;
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

  const growthScored = useMemo(() => {
    const base = growthInputsFromChecks(growth);
    const np =
      qtr.panel?.rows.find((r) => r.label === "Net Profit")?.values ?? null;
    const patTtm = patTtmGrowthFromQuarters(np);
    return napkinGrowth({
      ...base,
      pat_ttm: patTtm,
    });
  }, [growth, qtr.panel]);

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

      <NapkinPerformance performance={performance} />

      <NapkinChecklistCard title="Growth" performance={growthScored} />

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
