"use client";

import { useCallback, useEffect, useState } from "react";

type Props = {
  market?: string;
  /** Tickers visible on the current map page (for refresh). */
  pageTickers?: string[];
  onDone?: () => void | Promise<void>;
  /** inline = compact toolbar buttons; block = full progress card */
  variant?: "inline" | "block";
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
  seat_events?: number;
  saved_tickers?: string[];
  message?: string;
  details?: Array<{
    ticker: string;
    status: string;
    seats: number;
    detail: string;
  }>;
};

async function scanOnce(
  path: "/api/governance-scan" | "/api/governance-web-din",
  body: Record<string, unknown>,
) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed`);
  return (await res.json()) as ScanJson;
}

/** NSE DIN board fetch — upserts into governance.db, never wipes it. */
export function GovernanceScanBar({
  market = "All",
  pageTickers,
  onDone,
  variant = "block",
}: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [webPending, setWebPending] = useState<number | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const [nse, web] = await Promise.all([
        fetch(`/api/governance-scan?market=${encodeURIComponent(market)}`),
        fetch(`/api/governance-web-din?market=${encodeURIComponent(market)}`),
      ]);
      if (nse.ok) {
        const json = (await nse.json()) as { pending?: number };
        if (typeof json.pending === "number") setPending(json.pending);
      }
      if (web.ok) {
        const json = (await web.json()) as { pending?: number };
        if (typeof json.pending === "number") setWebPending(json.pending);
      }
    } catch {
      /* ignore */
    }
  }, [market]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const runNse = useCallback(
    async (mode: "pending" | "page") => {
      setBusy(true);
      const pageMode = mode === "page";
      setProgress({
        pct: 8,
        label: pageMode ? "Scan page" : "Scan NSE",
        detail: "NSE DIN boards · upsert only",
      });

      let gotSaved = 0;
      let gotDins = 0;
      let gotDirs = 0;
      let gotSeats = 0;
      let gotEvents = 0;
      let remaining = pageMode
        ? Math.max(pageTickers?.length || 1, 1)
        : Math.max(pending ?? 200, 1);

      try {
        for (let round = 1; round <= (pageMode ? 1 : 60); round += 1) {
          const json = await scanOnce("/api/governance-scan", {
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
          gotEvents += json.seat_events || 0;
          remaining = json.remaining;
          const pct = pageMode
            ? 100
            : remaining <= 0
              ? 100
              : Math.min(96, 8 + round * 2);
          setProgress({
            pct,
            label: pageMode ? "Page done" : `NSE batch ${round}`,
            detail: `+${gotDins} DIN · +${gotDirs} directors · ${gotSaved} saved${
              gotEvents ? ` · ${gotEvents} changes` : ""
            }${pageMode ? "" : ` · ${remaining.toLocaleString()} left`}`,
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
          detail: `+${gotDins} new DIN · +${gotDirs} new directors · +${gotSeats} seats · ${gotSaved} boards · ${gotEvents} changes`,
          done: true,
        });
        await refreshStatus();
      } catch {
        setProgress({
          pct: 100,
          label: "Failed",
          detail: "NSE board scan failed",
          error: true,
        });
      } finally {
        setBusy(false);
        await onDone?.();
      }
    },
    [market, pageTickers, pending, onDone, refreshStatus],
  );

  const runWeb = useCallback(
    async (mode: "pending" | "page") => {
      setBusy(true);
      const pageMode = mode === "page";
      const initial = pageMode
        ? Math.max(pageTickers?.length || 1, 1)
        : Math.max(webPending ?? pending ?? 20, 1);
      setProgress({
        pct: 4,
        label: pageMode ? "Web DIN · page" : "Web DIN · Qwen",
        detail: "Fetching registries · extracting with Qwen…",
      });

      let gotSaved = 0;
      let gotDins = 0;
      let remaining = initial;
      const lastTickers: string[] = [];

      try {
        for (let round = 1; round <= (pageMode ? 1 : 80); round += 1) {
          const closed = Math.max(0, initial - remaining);
          setProgress({
            pct: pageMode
              ? 40
              : Math.min(96, Math.round((closed / initial) * 100) + 4),
            label: pageMode ? "Web DIN · page" : `Web DIN batch ${round}`,
            detail:
              lastTickers.length > 0
                ? `${gotSaved} saved · +${gotDins} DIN · last ${lastTickers.join(", ")} · ${remaining} left`
                : `Fetching + Qwen extract · ${remaining} left`,
          });

          const json = await scanOnce("/api/governance-web-din", {
            market,
            tickers: pageMode ? pageTickers : undefined,
            limit: pageMode
              ? Math.min(pageTickers?.length || 5, 8)
              : 3,
            missingOnly: true,
          });
          gotSaved += json.saved;
          gotDins += json.new_dins?.length || 0;
          remaining = json.remaining;
          if (json.saved_tickers?.length) {
            lastTickers.splice(
              0,
              lastTickers.length,
              ...json.saved_tickers.slice(0, 4),
            );
          } else if (json.details?.length) {
            lastTickers.splice(
              0,
              lastTickers.length,
              ...json.details.slice(0, 3).map((d) => d.ticker),
            );
          }

          setProgress({
            pct: pageMode
              ? 100
              : remaining <= 0
                ? 100
                : Math.min(
                    96,
                    Math.round(((initial - remaining) / initial) * 100) + 4,
                  ),
            label: pageMode ? "Web DIN page done" : `Web DIN batch ${round}`,
            detail: `${gotSaved} boards · +${gotDins} DIN${
              lastTickers.length ? ` · ${lastTickers.join(", ")}` : ""
            }${pageMode ? "" : ` · ${remaining.toLocaleString()} left`}`,
            done: pageMode || remaining <= 0,
          });
          await onDone?.();
          if (pageMode) break;
          if (json.tried === 0 || remaining <= 0) break;
          await new Promise((r) => setTimeout(r, 400));
        }
        setProgress({
          pct: 100,
          label: "Web DIN complete",
          detail: `${gotSaved} boards saved · +${gotDins} DIN`,
          done: true,
        });
        await refreshStatus();
      } catch {
        setProgress({
          pct: 100,
          label: "Failed",
          detail: "Web DIN / Qwen scan failed — is Ollama up?",
          error: true,
        });
      } finally {
        setBusy(false);
        await onDone?.();
      }
    },
    [market, pageTickers, pending, webPending, onDone, refreshStatus],
  );

  const progressBlock =
    busy || progress ? (
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
    ) : null;

  if (variant === "inline") {
    return (
      <div className="gov-scan-inline">
        <button
          type="button"
          className="chip chip-scan"
          disabled={busy}
          onClick={() => void runNse("pending")}
          title="Fetch NSE DIN boards for tickers not yet in governance.db"
        >
          {busy ? "…" : "Scan"}
          {pending != null ? (
            <span className="chip-count">{pending.toLocaleString()}</span>
          ) : null}
        </button>
        {progressBlock}
      </div>
    );
  }

  return (
    <div className="scan-block gov-scan">
      <div className="chip-row">
        <span className="chip-label">NSE boards</span>
        <button
          type="button"
          className="btn-scan"
          disabled={busy || !pageTickers?.length}
          onClick={() => void runNse("page")}
          title="Re-fetch boards for tickers on this page (upsert, no wipe)"
        >
          Scan page
        </button>
        <button
          type="button"
          className="btn-scan-all chip chip-scan"
          disabled={busy}
          onClick={() => void runNse("pending")}
          title="Fetch DIN boards for tickers not yet in governance.db"
        >
          Scan
          {pending != null ? (
            <span className="chip-count">{pending.toLocaleString()}</span>
          ) : null}
        </button>
      </div>
      <div className="chip-row" style={{ marginTop: 8 }}>
        <span className="chip-label">Web DIN</span>
        <button
          type="button"
          className="btn-scan"
          disabled={busy || !pageTickers?.length}
          onClick={() => void runWeb("page")}
          title="Fetch company/registry pages + extract DINs with Qwen for this page"
        >
          {busy ? "Scanning…" : "Scan page"}
        </button>
        <button
          type="button"
          className="btn-scan-all chip chip-scan"
          disabled={busy}
          onClick={() => void runWeb("pending")}
          title="Web evidence + Qwen DIN extract for all missing DIN boards"
        >
          {busy ? "…" : "Scan"}
          {webPending != null ? (
            <span className="chip-count">{webPending.toLocaleString()}</span>
          ) : null}
        </button>
      </div>
      {progressBlock}
    </div>
  );
}
