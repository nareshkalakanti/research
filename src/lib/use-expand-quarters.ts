"use client";

import { useEffect, useRef, useState } from "react";
import type { PanelYoY, QuarterExtraMetrics, QuarterPanel } from "@/lib/quarter-panel";

export type ExpandQuarterData = {
  panel: QuarterPanel | null;
  forward_pe: number | null;
  yoy: PanelYoY | null;
  extras: QuarterExtraMetrics | null;
  source: string | null;
  loading: boolean;
  error: string | null;
};

/**
 * Loads quarters when expanded. Collapse must not cancel or clear — task keeps
 * running in the background and results apply when ready.
 */
export function useExpandQuarters(
  ticker: string,
  market: string | null | undefined,
  price: number | null | undefined,
  enabled: boolean,
): ExpandQuarterData {
  const [panel, setPanel] = useState<QuarterPanel | null>(null);
  const [forwardPe, setForwardPe] = useState<number | null>(null);
  const [yoy, setYoy] = useState<PanelYoY | null>(null);
  const [extras, setExtras] = useState<QuarterExtraMetrics | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const genRef = useRef(0);
  const paramsRef = useRef({ ticker, market, price });

  // Invalidate in-flight work only when identity params change (not on minimise)
  useEffect(() => {
    const prev = paramsRef.current;
    const changed =
      prev.ticker !== ticker ||
      prev.market !== market ||
      prev.price !== price;
    paramsRef.current = { ticker, market, price };
    if (!changed) return;
    genRef.current += 1;
    if (!ticker) {
      setPanel(null);
      setForwardPe(null);
      setYoy(null);
      setExtras(null);
      setSource(null);
      setLoading(false);
      setError(null);
    }
  }, [ticker, market, price]);

  useEffect(() => {
    if (!enabled || !ticker) return;

    const gen = ++genRef.current;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ ticker });
    if (market) params.set("market", market);
    if (price != null && Number.isFinite(price) && price > 0) {
      params.set("price", String(price));
    }

    void fetch(`/api/quarters?${params}`, { signal: AbortSignal.timeout(90_000) })
      .then(async (r) => {
        const j = (await r.json()) as {
          ok?: boolean;
          quarters?: QuarterPanel | null;
          forward_pe?: number;
          yoy?: PanelYoY | null;
          extras?: QuarterExtraMetrics | null;
          source?: string;
          error?: string;
        };
        if (gen !== genRef.current) return;
        if (!r.ok || j.ok === false) {
          setPanel(null);
          setForwardPe(null);
          setYoy(null);
          setExtras(null);
          setSource(null);
          setError(j.error || "Could not load quarters");
          return;
        }
        if (!j.quarters?.labels?.length) {
          setPanel(null);
          setForwardPe(j.forward_pe ?? null);
          setYoy(j.yoy ?? null);
          setExtras(j.extras ?? null);
          setSource(j.source ?? null);
          setError(j.error || "No quarterly data available");
          return;
        }
        setPanel(j.quarters ?? null);
        setForwardPe(j.forward_pe ?? null);
        setYoy(j.yoy ?? null);
        setExtras(j.extras ?? null);
        setSource(j.source ?? null);
      })
      .catch(() => {
        if (gen === genRef.current) {
          setError("Could not load quarters");
        }
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false);
      });
  }, [ticker, market, price, enabled]);

  return {
    panel,
    forward_pe: forwardPe,
    yoy,
    extras,
    source,
    loading,
    error,
  };
}
