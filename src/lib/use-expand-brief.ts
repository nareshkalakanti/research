"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

/**
 * Loads business brief when expanded. Minimise must not cancel or clear —
 * the request keeps running and results land when ready.
 */
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
  const genRef = useRef(0);
  const paramsRef = useRef({ ticker, market, price, materialsRev });

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
    const prev = paramsRef.current;
    const changed =
      prev.ticker !== ticker ||
      prev.market !== market ||
      prev.price !== price ||
      prev.materialsRev !== materialsRev;
    paramsRef.current = { ticker, market, price, materialsRev };
    if (!changed) return;
    genRef.current += 1;
    if (!ticker) {
      setBrief(null);
      setContext(null);
      setLoading(false);
      setError(null);
      setSetupHint(null);
    }
  }, [ticker, market, price, materialsRev]);

  useEffect(() => {
    if (!enabled || !ticker) return;

    const gen = ++genRef.current;
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
      signal: AbortSignal.timeout(300_000),
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
        if (gen !== genRef.current) return;
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
        if (gen !== genRef.current) return;
        const msg =
          err instanceof Error && /timeout|aborted/i.test(err.message)
            ? "Business brief timed out — try again or check Ollama is running"
            : "Network error — could not load business brief";
        setError(msg);
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false);
      });
  }, [enabled, ticker, market, price, quarterBlock, materialsRev]);

  return {
    brief,
    context,
    loading,
    waitingForQuarters: enabled && quarters.loading && loading && !brief,
    error,
    setupHint,
  };
}
