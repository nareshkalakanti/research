"use client";

import { useEffect, useMemo, useState } from "react";
import type { CompanyBrief, CompanyBriefContext } from "@/lib/company-brief";
import { formatQuarterBriefBlock } from "@/lib/quarter-panel";
import type { ExpandQuarterData } from "@/lib/use-expand-quarters";

export type ExpandBriefData = {
  brief: CompanyBrief | null;
  context: CompanyBriefContext | null;
  loading: boolean;
  waitingForQuarters: boolean;
  error: string | null;
  setupHint: string | null;
};

export function useExpandBrief(
  ticker: string,
  market: string | null | undefined,
  price: number | null | undefined,
  quarters: ExpandQuarterData,
  enabled: boolean,
  materialsRev = 0,
): ExpandBriefData {
  const [brief, setBrief] = useState<CompanyBrief | null>(null);
  const [context, setContext] = useState<CompanyBriefContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupHint, setSetupHint] = useState<string | null>(null);

  const quarterBlock = useMemo(() => {
    if (!quarters.panel) return null;
    return formatQuarterBriefBlock(quarters.panel, {
      forward_pe: quarters.forward_pe,
      yoy: quarters.yoy,
      extras: quarters.extras,
      price: price ?? null,
    });
  }, [
    quarters.panel,
    quarters.forward_pe,
    quarters.yoy,
    quarters.extras,
    price,
  ]);

  useEffect(() => {
    if (!enabled || !ticker) {
      setBrief(null);
      setContext(null);
      setLoading(false);
      setError(null);
      setSetupHint(null);
      return;
    }

    if (quarters.loading) {
      setLoading(true);
      setError(null);
      setSetupHint(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSetupHint(null);

    void fetch("/api/company-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker,
        market: market || null,
        price:
          price != null && Number.isFinite(price) && price > 0 ? price : null,
        quarterBlock,
        quarterPanel: quarters.panel,
      }),
      signal: AbortSignal.timeout(180_000),
    })
      .then(async (r) => {
        const j = (await r.json()) as {
          ok?: boolean;
          brief?: CompanyBrief | null;
          context?: CompanyBriefContext | null;
          cached?: boolean;
          error?: string;
          hint?: string;
        };
        if (cancelled) return;
        setContext(j.context ?? null);
        if (!r.ok || j.ok === false) {
          setBrief(null);
          setError(j.error || "Could not generate business brief");
          setSetupHint(j.hint ?? null);
          return;
        }
        setBrief(j.brief ?? null);
      })
      .catch((err) => {
        if (!cancelled) {
          setBrief(null);
          const msg =
            err instanceof Error && /timeout|aborted/i.test(err.message)
              ? "Business brief timed out — try again or check Ollama is running"
              : "Network error — could not load business brief";
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, ticker, market, price, quarters.loading, quarterBlock, quarters.panel, materialsRev]);

  return {
    brief,
    context,
    loading,
    waitingForQuarters: enabled && quarters.loading,
    error,
    setupHint,
  };
}
