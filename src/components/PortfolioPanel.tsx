"use client";

import { useCallback, useEffect, useState } from "react";
import {
  invalidateReviewMembership,
} from "@/components/ReviewPlusButton";
import { PortfolioReviewPanel } from "@/components/PortfolioReviewPanel";
import { ExcellentList } from "@/components/ExcellentList";
import { PORTFOLIO_BAG } from "@/lib/portfolio-review-types";

type UniverseStock = {
  t: string;
  name: string;
  market: string;
  industry: string | null;
  mcap: number | null;
};

/**
 * Dedicated Portfolio page — evaluation table.
 * Stocks arrive via + on Napkin / Value / Trend / Dashboard.
 */
export function PortfolioPanel() {
  const [universe, setUniverse] = useState<UniverseStock[] | null>(null);

  const loadUniverse = useCallback(() => {
    void (async () => {
      try {
        const res = await fetch("/api/value-tools?kind=universe&include_portfolio=1", {
          cache: "no-store",
        });
        const j = (await res.json()) as { ok?: boolean; rows?: UniverseStock[] };
        if (res.ok && j.ok !== false) setUniverse(j.rows ?? []);
      } catch {
        /* search still works via /api/tickers */
      }
    })();
  }, []);

  useEffect(() => {
    loadUniverse();
  }, [loadUniverse]);

  return (
    <section className="vx portfolio-page">
      <header className="vx-head">
        <div>
          <h1 className="vx-title">Portfolio</h1>
          <p className="vx-lede">
            Stocks you mark with <strong>+</strong> on Napkin, Value, Trend, or Dashboard.
            Fundamental · management · valuation scores.
          </p>
        </div>
      </header>
      <PortfolioReviewPanel
        bag={PORTFOLIO_BAG}
        universe={universe}
        onMembershipChange={() => {
          invalidateReviewMembership(PORTFOLIO_BAG);
          window.dispatchEvent(new CustomEvent("portfolio-review-changed"));
          loadUniverse();
        }}
      />
      <ExcellentList />
    </section>
  );
}
