"use client";

import { useEffect, useState } from "react";
import { VerdictRowCard } from "@/components/VerdictRowCard";
import type { VerdictRow } from "@/lib/agents/types";

type Props = {
  ticker: string;
  onOpenAgents?: () => void;
};

export function ScanAiTab({ ticker, onOpenAgents }: Props) {
  const [verdict, setVerdict] = useState<VerdictRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetch(`/api/agents/verdict?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((j: { verdict?: VerdictRow | null; source?: string }) => {
        if (cancelled) return;
        setVerdict(j.verdict ?? null);
        setSource(j.source ?? null);
      })
      .catch(() => {
        if (!cancelled) setVerdict(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  if (loading) {
    return <p className="scan-ai-empty">Loading AI verdict…</p>;
  }

  if (verdict) {
    return (
      <div className="scan-ai-verdict">
        {source ? (
          <p className="scan-ai-meta">From last Agents run ({source})</p>
        ) : null}
        <VerdictRowCard row={verdict} open onToggle={() => {}} />
      </div>
    );
  }

  return (
    <div className="scan-ai-empty">
      <p>No AI verdict for {ticker} yet.</p>
      <p className="hint">
        Run a full analysis on the Agents tab — demo mode covers KAYNES, TCS,
        and RELIANCE; live mode scans your selected list.
      </p>
      {onOpenAgents ? (
        <button type="button" className="btn-secondary" onClick={onOpenAgents}>
          Open Agents
        </button>
      ) : null}
    </div>
  );
}
