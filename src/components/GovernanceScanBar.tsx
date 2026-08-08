"use client";

import { useCallback, useEffect, useState } from "react";

type Props = {
  market?: string;
  /** Tickers visible on the current map page (for refresh). */
  pageTickers?: string[];
  onDone?: () => void | Promise<void>;
};

type Progress = {
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
};

type ScanJson = {
  tried: number;
  saved: number;
  failed: number;
  skipped_empty: number;
  remaining: number;
  new_dins: string[];
  new_directors: Array<{ person_id: string; din: string | null; name: string }>;
  new_seats: number;
  message?: string;
};

async function scanOnce(body: Record<string, unknown>) {
  const res = await fetch("/api/governance-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("governance scan failed");
  return (await res.json()) as ScanJson;
}

/** NSE DIN board refresh — upserts into governance.db, never wipes it. */
export function GovernanceScanBar({
  market = "NSE",
  pageTickers,
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [pending, setPending] = useState<number | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/governance-scan?market=${encodeURIComponent(market)}`,
      );
      if (!res.ok) return;
      const json = (await res.json()) as { pending?: number };
      if (typeof json.pending === "number") setPending(json.pending);
    } catch {
      /* ignore */
    }
  }, [market]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const run = useCallback(
    async (mode: "pending" | "page") => {
      setBusy(true);
      const pageMode = mode === "page";
      setProgress({
        pct: 8,
        label: pageMode ? "Refresh page" : "Scan pending",
        detail: "NSE DIN boards · upsert only",
      });

      let gotSaved = 0;
      let gotDins = 0;
      let gotDirs = 0;
      let gotSeats = 0;
      let remaining = pageMode
        ? Math.max(pageTickers?.length || 1, 1)
        : Math.max(pending ?? 200, 1);

      try {
        for (let round = 1; round <= (pageMode ? 1 : 60); round += 1) {
          const json = await scanOnce({
            market,
            tickers: pageMode ? pageTickers : undefined,
            limit: pageMode
              ? Math.min(pageTickers?.length || 12, 20)
              : 10,
            missingOnly: !pageMode,
          });
          gotSaved += json.saved;
          gotDins += json.new_dins?.length || 0;
          gotDirs += json.new_directors?.length || 0;
          gotSeats += json.new_seats || 0;
          remaining = json.remaining;
          const pct = pageMode
            ? 100
            : remaining <= 0
              ? 100
              : Math.min(96, 8 + round * 2);
          setProgress({
            pct,
            label: pageMode ? "Page done" : `Batch ${round}`,
            detail: `+${gotDins} DIN · +${gotDirs} directors · ${gotSaved} saved${
              pageMode ? "" : ` · ${remaining.toLocaleString()} left`
            }`,
            done: pageMode || remaining <= 0,
          });
          await onDone?.();
          if (pageMode) break;
          if (json.tried === 0 || remaining <= 0) break;
          await new Promise((r) => setTimeout(r, 350));
        }
        setProgress({
          pct: 100,
          label: "Complete",
          detail: `+${gotDins} new DIN · +${gotDirs} new directors · +${gotSeats} seats · ${gotSaved} boards saved`,
          done: true,
        });
        await refreshStatus();
      } catch {
        setProgress({
          pct: 100,
          label: "Failed",
          detail: "NSE scan request failed",
          error: true,
        });
      } finally {
        setBusy(false);
        await onDone?.();
      }
    },
    [market, pageTickers, pending, onDone, refreshStatus],
  );

  return (
    <div className="scan-block gov-scan">
      <div className="chip-row">
        <span className="chip-label">NSE boards</span>
        <button
          type="button"
          className="btn-scan"
          disabled={busy || !pageTickers?.length}
          onClick={() => void run("page")}
          title="Re-fetch boards for tickers on this page (upsert, no wipe)"
        >
          Refresh page
        </button>
        <button
          type="button"
          className="btn-scan-all"
          disabled={busy}
          onClick={() => void run("pending")}
          title="Fetch DIN boards for tickers not yet in governance.db"
        >
          Scan pending
          {pending != null ? (
            <span className="chip-count">{pending.toLocaleString()}</span>
          ) : null}
        </button>
      </div>
      {busy || progress ? (
        <div
          className={`fill-progress scan-progress ${progress?.error ? "is-error" : ""} ${progress?.done ? "is-done" : ""}`}
          role="status"
        >
          <div className="fill-progress-meta">
            <span className="fill-progress-label">
              {progress?.label || "Working…"}
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
      ) : null}
    </div>
  );
}
