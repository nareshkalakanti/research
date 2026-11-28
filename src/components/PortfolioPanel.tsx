"use client";

import { useCallback, useEffect, useState } from "react";
import {
  invalidateReviewMembership,
} from "@/components/ReviewPlusButton";
import { PortfolioReviewPanel } from "@/components/PortfolioReviewPanel";
import { PORTFOLIO_BAG } from "@/lib/portfolio-review-types";

type UniverseStock = {
  t: string;
  name: string;
  market: string;
  industry: string | null;
  mcap: number | null;
};

/**
 * Portfolio under Intrinsic Value — stock eval table only.
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
      <PortfolioReviewPanel
        bag={PORTFOLIO_BAG}
        universe={universe}
        onMembershipChange={() => {
          invalidateReviewMembership(PORTFOLIO_BAG);
          window.dispatchEvent(new CustomEvent("portfolio-review-changed"));
          loadUniverse();
        }}
      />
    </section>
  );
}
