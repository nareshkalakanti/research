"use client";

import { useEffect, useState } from "react";
import type { PanelYoY, QuarterExtraMetrics, QuarterPanel } from "@/lib/quarter-panel";

export type ExpandQuarterData = {
  panel: QuarterPanel | null;
  forward_pe: number | null;
  yoy: PanelYoY | null;
  extras: QuarterExtraMetrics | null;
  loading: boolean;
  error: string | null;
};

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !ticker) {
      setPanel(null);
      setForwardPe(null);
      setYoy(null);
      setExtras(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ ticker });
    if (market) params.set("market", market);
    if (price != null && Number.isFinite(price) && price > 0) {
      params.set("price", String(price));
    }

    void fetch(`/api/quarters?${params}`)
      .then(async (r) => {
        const j = (await r.json()) as {
          ok?: boolean;
          quarters?: QuarterPanel | null;
          forward_pe?: number;
          yoy?: PanelYoY | null;
          extras?: QuarterExtraMetrics | null;
          error?: string;
        };
        if (cancelled) return;
        if (!r.ok || j.ok === false) {
          setPanel(null);
          setForwardPe(null);
          setYoy(null);
          setExtras(null);
          setError(j.error || "Could not load quarters");
          return;
        }
        if (!j.quarters?.labels?.length) {
          params.set("refresh", "1");
          const retry = await fetch(`/api/quarters?${params}`);
          const j2 = (await retry.json()) as typeof j;
          if (cancelled) return;
          if (!retry.ok || j2.ok === false || !j2.quarters?.labels?.length) {
            setPanel(null);
            setForwardPe(j2.forward_pe ?? null);
            setYoy(j2.yoy ?? null);
            setExtras(j2.extras ?? null);
            setError(j2.error || "No quarterly data available");
            return;
          }
          setPanel(j2.quarters ?? null);
          setForwardPe(j2.forward_pe ?? null);
          setYoy(j2.yoy ?? null);
          setExtras(j2.extras ?? null);
          return;
        }
        setPanel(j.quarters ?? null);
        setForwardPe(j.forward_pe ?? null);
        setYoy(j.yoy ?? null);
        setExtras(j.extras ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setPanel(null);
          setForwardPe(null);
          setYoy(null);
          setExtras(null);
          setError("Could not load quarters");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ticker, market, price, enabled]);

  return {
    panel,
    forward_pe: forwardPe,
    yoy,
    extras,
    loading,
    error,
  };
}
