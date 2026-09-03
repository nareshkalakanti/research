"use client";

import { useCallback, useState } from "react";

type FillResult = {
  ok: boolean;
  tried: number;
  saved: number;
  filledPrice: number;
  filledMcap: number;
  failed?: number;
  remaining: number;
  remainingMcap?: number;
  triedTickers?: string[];
  closedTickers?: string[];
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
  const res = await fetch("/api/fill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, source: "web" }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = (await res.json()) as FillResult;
  if (!res.ok) throw new Error(json.message || "Tickertape fill failed");
  return json;
}

export function FillWebMcapButton({
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
    setProgress({
      pct: 12,
      label: "Tickertape / Groww",
      detail: `${gapCount} names`,
    });
    try {
      const json = await fillOnce({
        market,
        tickers: tickers?.length ? tickers : undefined,
        limit: tickers?.length ? Math.min(tickers.length, 40) : 40,
        concurrency: 4,
        missingOnly: true,
      });
      const left = json.remainingMcap ?? json.remaining;
      await finish({
        pct: json.remainingMcap === 0 || left === 0 ? 100 : 90,
        label: left === 0 ? "Complete" : "Partial",
        detail:
          json.message ||
          `+${json.filledMcap} mcap · ${left.toLocaleString()} still missing`,
        done: left === 0,
        error: json.filledMcap === 0 && json.tried > 0,
      });
    } catch {
      await finish({
        pct: 100,
        label: "Failed",
        detail: "Tickertape/Groww fill failed",
        error: true,
      });
    }
  }, [market, tickers, gapCount, finish]);

  const runAll = useCallback(async () => {
    const initial = Math.max(totalGaps || gapCount || 1, 1);
    setBusy(true);
    let remaining = initial;
    let saved = 0;
    const skipTickers: string[] = [];

    try {
      for (let round = 1; round <= 60; round += 1) {
        const closed = Math.max(0, initial - remaining);
        setProgress({
          pct: Math.min(96, Math.round((closed / initial) * 100) + 4),
          label: `Tickertape ${round}`,
          detail: `${saved} mcap · ${remaining.toLocaleString()} left`,
        });
        const json = await fillOnce({
          market,
          limit: 40,
          concurrency: 4,
          missingOnly: true,
          skipTickers,
        });
        saved += json.filledMcap;
        remaining = json.remainingMcap ?? json.remaining;
        for (const t of json.closedTickers ?? json.triedTickers ?? []) {
          if (!skipTickers.includes(t.toUpperCase())) {
            skipTickers.push(t.toUpperCase());
          }
        }
        if (remaining <= 0 || json.tried === 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await finish({
        pct: remaining <= 0 ? 100 : 95,
        label: remaining <= 0 ? "Complete" : "Done",
        detail:
          remaining <= 0
            ? `All written (${saved})`
            : `${saved} mcap · ${remaining.toLocaleString()} left`,
        done: remaining <= 0,
      });
    } catch {
      await finish({
        pct: 100,
        label: "Failed",
        detail: "Tickertape batch stopped",
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
          title="Fill missing mcap from Tickertape, Groww if needed — this page only"
        >
          Tickertape · page
          {gapCount > 0 ? <span className="btn-count">{gapCount}</span> : null}
        </button>
        {totalGaps > 0 ? (
          <button
            type="button"
            className="btn-fill-all"
            disabled={busy || !totalGaps}
            onClick={() => void runAll()}
            title="Fill missing mcap from Tickertape, Groww if needed — all gaps in this list"
          >
            Tickertape · all
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
