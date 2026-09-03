"use client";

import { useCallback, useEffect, useState } from "react";

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
  triedTickers?: string[];
  closedTickers?: string[];
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

async function fillOnce(
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<FillResult> {
  const res = await fetch("/api/fill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      setProgress((p) => {
        if (!p || p.done || p.error) return p;
        const next = Math.min(p.pct + 5, 84);
        if (next === p.pct) return p;
        return { ...p, pct: next };
      });
    }, 700);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    if (busy || !progress) return;
    const ms = progress.error ? 2800 : 1200;
    const t = setTimeout(() => setProgress(null), ms);
    return () => clearTimeout(t);
  }, [busy, progress]);

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
      const json = await fillOnce(
        {
          market,
          tickers: tickers?.length ? tickers : undefined,
          limit: tickers?.length ? Math.min(tickers.length, 120) : 80,
          concurrency: 12,
          missingOnly: true,
          preferMcap: true,
        },
        120_000,
      );
      const left = json.remainingMcap ?? json.remaining;
      await finish({
        pct: 100,
        label: left === 0 ? "Complete" : "Done",
        detail:
          left === 0
            ? `+${json.filledMcap} mcap · +${json.filledPrice} price`
            : `+${json.filledMcap} mcap · +${json.filledPrice} price · ${left} still missing mcap`,
        done: true,
        error: json.filledMcap === 0 && json.filledPrice === 0 && left > 0,
      });
    } catch {
      await finish({
        pct: 100,
        label: "Failed",
        detail: "Fill timed out or failed",
        error: true,
      });
    }
  }, [market, tickers, gapCount, finish]);

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
    const skipTickers: string[] = [];

    try {
      for (let round = 1; round <= 80; round += 1) {
        const closed = Math.max(0, initial - remaining);
        const pct = Math.min(96, Math.round((closed / initial) * 100) + 5);
        setProgress({
          pct,
          label: round === 1 ? "Yahoo + NSE + Tickertape" : `Batch ${round}`,
          detail: `${closed.toLocaleString()} done · ${remaining.toLocaleString()} left`,
        });

        const shard = (offset: number) =>
          fillOnce(
            {
              market,
              limit: 80,
              concurrency: 8,
              offset,
              missingOnly: true,
              preferMcap: true,
              skipTickers,
            },
            180_000,
          );
        const [jsonA, jsonB] = await Promise.all([shard(0), shard(80)]);
        const jsons = [jsonA, jsonB];
        let tried = 0;
        for (const json of jsons) {
          gotMcap += json.filledMcap;
          gotPrice += json.filledPrice;
          tried += json.tried;
          for (const t of json.closedTickers ?? json.triedTickers ?? []) {
            if (!skipTickers.includes(t.toUpperCase())) {
              skipTickers.push(t.toUpperCase());
            }
          }
        }
        remaining = Math.min(
          ...jsons.map((j) => j.remainingMcap ?? j.remaining),
        );
        if (remaining <= 0) break;
        if (tried === 0) break;
        await new Promise((r) => setTimeout(r, 280));
      }

      const closed = Math.max(0, initial - remaining);
      await finish({
        pct: 100,
        label: remaining <= 0 ? "Complete" : "Done",
        detail:
          remaining <= 0
            ? `All closed · +${gotMcap} mcap · +${gotPrice} price`
            : `${closed} closed · ${remaining} left (no mcap source)`,
        done: true,
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
