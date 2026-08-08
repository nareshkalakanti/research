"use client";

import { useCallback, useState } from "react";

type FillResult = {
  ok: boolean;
  tried: number;
  saved: number;
  filledPrice: number;
  filledMcap: number;
  failed?: number;
  seeded?: number;
  remaining: number;
  remainingMcap?: number;
  message?: string;
};

type Props = {
  market: string;
  tickers?: string[];
  gapCount?: number;
  totalGaps?: number;
  /** inline = toolbar buttons; panel = full fill card (Missing data) */
  variant?: "inline" | "panel";
  onDone?: () => void | Promise<void>;
};

type Progress = {
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
};

async function fillOnce(body: Record<string, unknown>): Promise<FillResult> {
  const res = await fetch("/api/fill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("fill failed");
  return (await res.json()) as FillResult;
}

export function FillMissingButton({
  market,
  tickers,
  gapCount = 0,
  totalGaps = 0,
  variant = "panel",
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
    const target = Math.max(gapCount || tickers?.length || 0, 1);
    setBusy(true);
    setProgress({
      pct: 12,
      label: "Fetching",
      detail: `Page · ${target} names`,
    });
    try {
      const json = await fillOnce({
        market,
        tickers: tickers?.length ? tickers : undefined,
        limit: tickers?.length ? Math.min(tickers.length, 100) : 50,
        missingOnly: true,
        preferMcap: true,
      });
      await onDone?.();
      const left = json.remainingMcap ?? json.remaining;
      await finish({
        pct: left === 0 ? 100 : 90,
        label: left === 0 ? "Complete" : "Partial",
        detail:
          left === 0
            ? `+${json.filledMcap} mcap · +${json.filledPrice} price`
            : `+${json.filledMcap} mcap · +${json.filledPrice} price · ${left} left`,
        done: left === 0,
        error: left > 0 && json.filledMcap === 0 && json.filledPrice === 0,
      });
    } catch {
      await finish({
        pct: 100,
        label: "Failed",
        detail: "Fill request failed",
        error: true,
      });
    }
  }, [market, tickers, gapCount, onDone, finish]);

  const runAll = useCallback(async () => {
    const initial = Math.max(totalGaps || gapCount || 1, 1);
    setBusy(true);
    setProgress({
      pct: 5,
      label: "Starting",
      detail: `${initial.toLocaleString()} gaps`,
    });

    let remaining = initial;
    let gotMcap = 0;
    let gotPrice = 0;
    let stagnant = 0;

    try {
      for (let round = 1; round <= 50; round += 1) {
        const closed = Math.max(0, initial - remaining);
        const pct = Math.min(96, Math.round((closed / initial) * 100) + 5);
        setProgress({
          pct,
          label: round === 1 ? "Seed + Yahoo" : `Batch ${round}`,
          detail: `${closed.toLocaleString()} done · ${remaining.toLocaleString()} left`,
        });

        const json = await fillOnce({
          market,
          limit: 80,
          missingOnly: true,
          preferMcap: true,
        });

        gotMcap += json.filledMcap;
        gotPrice += json.filledPrice;
        const next = json.remainingMcap ?? json.remaining;
        if (
          next >= remaining &&
          json.filledMcap === 0 &&
          json.filledPrice === 0
        ) {
          stagnant += 1;
        } else {
          stagnant = 0;
        }
        remaining = next;
        await onDone?.();

        if (remaining <= 0) break;
        if (json.tried === 0) break;
        if (stagnant >= 2) break;
        await new Promise((r) => setTimeout(r, 280));
      }

      const closed = Math.max(0, initial - remaining);
      await finish({
        pct: remaining <= 0 ? 100 : Math.min(99, Math.round((closed / initial) * 100)),
        label: remaining <= 0 ? "Complete" : "Done",
        detail:
          remaining <= 0
            ? `All closed · +${gotMcap} mcap · +${gotPrice} price`
            : `${closed} closed · ${remaining} left (no Yahoo)`,
        done: remaining <= 0,
        error: remaining > 0 && closed === 0,
      });
    } catch {
      await finish({
        pct: 100,
        label: "Failed",
        detail: "Batch stopped",
        error: true,
      });
    }
  }, [market, totalGaps, gapCount, onDone, finish]);

  const showProgress = busy || !!progress;
  const pageDisabled = busy || !gapCount;
  const allDisabled = busy || !totalGaps;

  const actions = (
    <div className="fill-actions">
      <button
        type="button"
        className="btn-fill"
        disabled={pageDisabled}
        onClick={() => void runPage()}
      >
        Fill page
        {gapCount > 0 ? <span className="btn-count">{gapCount}</span> : null}
      </button>
      {variant === "panel" || totalGaps > 0 ? (
        <button
          type="button"
          className="btn-fill-all"
          disabled={allDisabled}
          onClick={() => void runAll()}
        >
          Fill all
          {totalGaps > 0 ? (
            <span className="btn-count">{totalGaps.toLocaleString()}</span>
          ) : null}
        </button>
      ) : null}
    </div>
  );

  const progressUi = showProgress ? (
    <div
      className={`fill-progress ${progress?.error ? "is-error" : ""} ${progress?.done ? "is-done" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="fill-progress-meta">
        <span className="fill-progress-label">
          {busy ? progress?.label || "Working…" : progress?.label}
        </span>
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
  ) : null;

  if (variant === "inline") {
    return (
      <div className={`fill-inline ${busy ? "is-busy" : ""}`}>
        {actions}
        {progressUi}
      </div>
    );
  }

  return (
    <div className={`fill-panel ${busy ? "is-busy" : ""}`}>
      {actions}
      {progressUi}
    </div>
  );
}
