"use client";

import { useCallback, useEffect, useState } from "react";

type Props = {
  market: string;
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

async function scanOnce(body: Record<string, unknown>) {
  const res = await fetch("/api/quarters/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json: {
    ok?: boolean;
    tried?: number;
    saved?: number;
    failed?: number;
    skipped?: number;
    remaining?: number;
    green?: number;
    message?: string;
    error?: string;
  } = {};
  if (raw) {
    try {
      json = JSON.parse(raw) as typeof json;
    } catch {
      throw new Error(`Scan failed (${res.status})`);
    }
  }
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || json.message || `Scan failed (${res.status})`);
  }
  return json;
}

function Count({ n }: { n?: number }) {
  if (n == null || n <= 0) return null;
  return <span className="chip-count">{n}</span>;
}

/** Batch-fetch quarter metrics so ●●● dots appear — skips names already scanned. */
export function MetricsFillButton({
  market,
  tickers,
  pendingCount,
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    if (!progress?.done || progress.error) return;
    const t = setTimeout(() => setProgress(null), 3500);
    return () => clearTimeout(t);
  }, [progress]);

  const run = useCallback(async () => {
    if (pendingCount != null && pendingCount <= 0) return;

    setBusy(true);
    setProgress({ pct: 4, label: "Fill dots", detail: "Starting…" });

    let remaining = pendingCount ?? 1;
    let filled = 0;
    let green = 0;
    let stagnant = 0;

    try {
      for (let round = 1; round <= 200; round += 1) {
        const json = await scanOnce({
          market,
          tickers: tickers?.length ? tickers : undefined,
          limit: 15,
          missingOnly: true,
        });

        if (json.message && (json.tried ?? 0) === 0) {
          green = json.green ?? green;
          remaining = json.remaining ?? 0;
          break;
        }

        filled += json.saved ?? 0;
        green = json.green ?? green;
        const nextRemaining = json.remaining ?? 0;

        if (
          (json.tried ?? 0) === 0 ||
          (nextRemaining >= remaining &&
            (json.saved ?? 0) === 0 &&
            (json.skipped ?? 0) === 0)
        ) {
          stagnant += 1;
        } else {
          stagnant = 0;
        }
        remaining = nextRemaining;

        const pct =
          remaining <= 0 ? 100 : Math.min(97, 4 + round * 2);
        setProgress({
          pct,
          label: remaining <= 0 ? "Done" : "Fill dots",
          detail: `${filled} filled · ${green} all-green · ${remaining.toLocaleString()} left`,
          done: remaining <= 0,
        });

        if (remaining <= 0 || stagnant >= 2) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      setProgress({
        pct: 100,
        label: remaining <= 0 ? "Done" : "Paused",
        detail:
          remaining <= 0
            ? `${filled} filled · ${green} all-green in list`
            : `${filled} filled · ${remaining.toLocaleString()} still need data`,
        done: remaining <= 0,
        error: remaining > 0 && filled === 0,
      });
      await onDone?.();
    } catch (e) {
      setProgress({
        pct: 100,
        label: "Failed",
        detail: e instanceof Error ? e.message : "Fill dots failed",
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }, [market, tickers, pendingCount, onDone]);

  const disabled = busy || (pendingCount != null && pendingCount <= 0);

  return (
    <div className="metrics-fill">
      <button
        type="button"
        className={`chip chip-scan ${busy ? "busy" : ""}`}
        disabled={disabled}
        onClick={() => void run()}
        title={
          pendingCount === 0
            ? "All names in this list already scanned"
            : "Fetch quarterly data for names not scanned yet"
        }
      >
        {busy ? "…" : pendingCount === 0 ? "Dots done" : "Fill dots"}
        <Count n={pendingCount} />
      </button>
      {busy || progress ? (
        <div
          className={`filter-progress metrics-fill-progress ${progress?.error ? "is-error" : ""} ${progress?.done ? "is-done" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className="filter-progress-track">
            <div
              className="filter-progress-fill"
              style={{ width: `${progress?.pct ?? (busy ? 6 : 0)}%` }}
            />
          </div>
          <span className="filter-progress-text">
            <strong>{progress?.label ?? "Fill dots"}</strong>
            {progress?.detail ? ` · ${progress.detail}` : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
