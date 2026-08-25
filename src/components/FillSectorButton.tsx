"use client";

import { useCallback, useState } from "react";

type FillResult = {
  ok: boolean;
  tried: number;
  saved: number;
  failed: number;
  remaining: number;
  saved_tickers?: string[];
  message?: string;
};

type Progress = {
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
};

type Props = {
  market: string;
  tickers?: string[];
  gapCount?: number;
  totalGaps?: number;
  onDone?: () => void | Promise<void>;
};

async function fillOnce(body: Record<string, unknown>): Promise<FillResult> {
  const res = await fetch("/api/sector-fill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as FillResult;
  if (!res.ok) throw new Error(json.message || "sector fill failed");
  return json;
}

export function FillSectorButton({
  market,
  tickers,
  gapCount = 0,
  totalGaps = 0,
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  const finish = useCallback(
    async (p: Progress) => {
      setProgress(p);
      setBusy(false);
      await onDone?.();
    },
    [onDone],
  );

  const runPage = useCallback(async () => {
    setBusy(true);
    setProgress({ pct: 12, label: "AI classify", detail: `${gapCount} names` });
    try {
      const json = await fillOnce({
        market,
        tickers: tickers?.length ? tickers : undefined,
        limit: tickers?.length ? Math.min(tickers.length, 50) : 20,
      });
      await finish({
        pct: json.remaining <= 0 ? 100 : 90,
        label: json.remaining <= 0 ? "Complete" : "Partial",
        detail: json.message || `+${json.saved} classified`,
        done: json.remaining <= 0,
        error: json.saved === 0 && json.tried > 0,
      });
    } catch {
      await finish({
        pct: 100,
        label: "Failed",
        detail: "Sector classify failed",
        error: true,
      });
    }
  }, [market, tickers, gapCount, finish]);

  const runAll = useCallback(async () => {
    const initial = Math.max(totalGaps || gapCount || 1, 1);
    setBusy(true);
    let remaining = initial;
    let saved = 0;

    try {
      for (let round = 1; round <= 30; round += 1) {
        const closed = Math.max(0, initial - remaining);
        setProgress({
          pct: Math.min(96, Math.round((closed / initial) * 100) + 4),
          label: `Batch ${round}`,
          detail: `${saved} saved · ${remaining} left`,
        });
        const json = await fillOnce({ market, limit: 30 });
        saved += json.saved;
        remaining = json.remaining;
        if (remaining <= 0 || json.tried === 0 || json.saved === 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await finish({
        pct: remaining <= 0 ? 100 : 95,
        label: remaining <= 0 ? "Complete" : "Done",
        detail:
          remaining <= 0
            ? `All classified (${saved})`
            : `${saved} classified · ${remaining} left`,
        done: remaining <= 0,
      });
    } catch {
      await finish({
        pct: 100,
        label: "Failed",
        detail: "Sector batch stopped",
        error: true,
      });
    }
  }, [market, totalGaps, gapCount, finish]);

  const showProgress = busy || !!progress;

  return (
    <div className={`fill-panel ${busy ? "is-busy" : ""}`}>
      <div className="fill-actions">
        <button
          type="button"
          className="btn-fill"
          disabled={busy || !gapCount}
          onClick={() => void runPage()}
        >
          AI sector · page
          {gapCount > 0 ? <span className="btn-count">{gapCount}</span> : null}
        </button>
        {totalGaps > 0 ? (
          <button
            type="button"
            className="btn-fill-all"
            disabled={busy || !totalGaps}
            onClick={() => void runAll()}
          >
            AI sector · all
            <span className="btn-count">{totalGaps.toLocaleString()}</span>
          </button>
        ) : null}
      </div>
      {showProgress ? (
        <div
          className={`fill-progress ${progress?.error ? "is-error" : ""} ${progress?.done ? "is-done" : ""}`}
          role="status"
        >
          <div className="fill-progress-meta">
            <span className="fill-progress-label">{progress?.label}</span>
            <span className="fill-progress-pct">{progress?.pct ?? 0}%</span>
          </div>
          <div className="fill-progress-track">
            <div
              className="fill-progress-bar"
              style={{ width: `${progress?.pct ?? 0}%` }}
            />
          </div>
          {progress?.detail ? (
            <p className="fill-progress-detail">{progress.detail}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
