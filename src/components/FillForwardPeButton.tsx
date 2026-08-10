"use client";

import { useCallback, useState } from "react";

type Props = {
  market: string;
  /** Prefer these tickers first (e.g. current page). */
  tickers?: string[];
  pendingCount?: number;
  onDone?: () => void | Promise<void>;
};

type Progress = {
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
};

const BATCH_LIMIT = 60;
const REFRESH_EVERY = 4;

async function forwardPeOnce(body: Record<string, unknown>) {
  const res = await fetch("/api/forward-pe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    ok?: boolean;
    tried?: number;
    saved?: number;
    remaining?: number;
    error?: string;
  };
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `Fwd PE failed (${res.status})`);
  }
  return json;
}

/** Fill missing Forward PE in batches (separate from BB/TQ Scan). */
export function FillForwardPeButton({
  market,
  tickers,
  pendingCount,
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setProgress({ pct: 5, label: "Fwd PE", detail: "Starting…" });

    let got = 0;
    let remaining = pendingCount ?? 1;
    const startTotal = pendingCount ?? remaining;

    try {
      for (let round = 1; round <= 120; round += 1) {
        const json = await forwardPeOnce({
          market,
          tickers: round === 1 && tickers?.length ? tickers : undefined,
          limit: BATCH_LIMIT,
          missingOnly: true,
        });
        got += json.saved ?? 0;
        remaining = json.remaining ?? 0;
        const done = remaining <= 0 || !json.tried;
        const pct =
          done || startTotal <= 0
            ? 100
            : Math.min(98, Math.round(((startTotal - remaining) / startTotal) * 100));
        setProgress({
          pct,
          label: done ? "Done" : "Fwd PE",
          detail: `${got.toLocaleString()} filled · ${remaining.toLocaleString()} left`,
          done,
        });
        if (done) break;
        if (round % REFRESH_EVERY === 0) {
          await onDone?.();
        }
      }

      setProgress({
        pct: 100,
        label: "Done",
        detail: `${got.toLocaleString()} Fwd PE filled`,
        done: true,
      });
      await onDone?.();
    } catch (e) {
      setProgress({
        pct: 100,
        label: "Failed",
        detail: e instanceof Error ? e.message : "Fwd PE fill failed",
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }, [market, onDone, pendingCount, tickers]);

  return (
    <div className="fpe-fill">
      <button
        type="button"
        className="breakout-scan fpe-fill-btn"
        disabled={busy}
        title="Fill missing Forward PE (Yahoo quarterly EPS × 4)"
        onClick={() => void run()}
      >
        {busy ? "Fwd PE…" : "Fwd PE"}
        {pendingCount != null && pendingCount > 0 ? (
          <em>{pendingCount}</em>
        ) : null}
      </button>
      {busy || progress ? (
        <div
          className={`breakout-progress ${progress?.error ? "is-error" : ""} ${progress?.done ? "is-done" : ""}`}
          role="status"
        >
          <div className="breakout-progress-track">
            <div
              className="breakout-progress-bar"
              style={{ width: `${progress?.pct ?? 0}%` }}
            />
          </div>
          <span className="breakout-progress-text">
            {progress?.detail || progress?.label || "Working…"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
