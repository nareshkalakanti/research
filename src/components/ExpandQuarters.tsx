"use client";

import { useEffect, useState } from "react";
import { QuarterPanel } from "@/components/QuarterPanel";
import type { QuarterPanel as QuarterPanelData } from "@/lib/quarter-panel";

type Props = {
  ticker: string;
  market?: string | null;
};

export function ExpandQuarters({ ticker, market }: Props) {
  const [panel, setPanel] = useState<QuarterPanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPanel(null);

    const params = new URLSearchParams({ ticker });
    if (market) params.set("market", market);

    void fetch(`/api/quarters?${params}`)
      .then(async (r) => {
        const j = (await r.json()) as {
          ok?: boolean;
          quarters?: QuarterPanelData | null;
          error?: string;
        };
        if (cancelled) return;
        if (!r.ok || j.ok === false) {
          setError(j.error || "Could not load quarters");
          return;
        }
        setPanel(j.quarters ?? null);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load quarters");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ticker, market]);

  if (loading) {
    return <p className="q-empty">Loading quarterly…</p>;
  }
  if (error) {
    return <p className="q-empty">{error}</p>;
  }
  if (!panel?.labels?.length) {
    return <p className="q-empty">No quarterly data available.</p>;
  }

  return (
    <div className="about-quarters">
      <QuarterPanel panel={panel} />
    </div>
  );
}
