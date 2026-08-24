"use client";

import { useCallback, useEffect, useState } from "react";
import { isScanWatchlist, type ScanList } from "@/lib/scan-lists";

type ScrapeResult = {
  tried: number;
  saved: number;
  failed: number;
  empty: number;
  remaining: number;
  saved_tickers?: string[];
  done?: boolean;
  message?: string;
  error?: string;
  page_stats?: {
    total: number;
    with_web: number;
    stored: number;
    eligible: number;
  };
};

type Progress = {
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
};

type ScanMode = "page" | "pending";

type Props = {
  market: ScanList;
  tickers: string[];
  listLabel: string;
  onBatch?: () => void | Promise<void>;
  onDone?: () => void | Promise<void>;
};

const BATCH = 5;

function formatDetail(opts: {
  saved: number;
  failed: number;
  empty: number;
  remaining: number | null;
  savedTickers?: string[];
  suffix?: string;
}): string {
  const parts: string[] = [];
  if (opts.savedTickers?.length) {
    const names = opts.savedTickers.slice(-3).join(", ");
    parts.push(`Saved ${names}`);
  }
  parts.push(
    `+${opts.saved} saved · ${opts.failed} failed · ${opts.empty} empty`,
  );
  if (opts.remaining != null) {
    parts.push(`${opts.remaining.toLocaleString()} left`);
  }
  if (opts.suffix) parts.push(opts.suffix);
  return parts.join(" · ");
}

async function scrapeOnce(body: Record<string, unknown>): Promise<ScrapeResult> {
  const res = await fetch("/api/about-scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json: ScrapeResult = {
    tried: 0,
    saved: 0,
    failed: 0,
    empty: 0,
    remaining: 0,
  };
  if (raw.trim()) {
    try {
      json = JSON.parse(raw) as ScrapeResult;
    } catch {
      throw new Error(`Invalid response (${res.status})`);
    }
  }
  if (!res.ok) {
    throw new Error(json.error || json.message || `Scrape failed (${res.status})`);
  }
  return json;
}

export function WebsiteScrapeBar({
  market,
  tickers,
  listLabel,
  onBatch,
  onDone,
}: Props) {
  const universeMarket = isScanWatchlist(market) ? "All" : market;
  const [pending, setPending] = useState<number | null>(null);
  const [busyMode, setBusyMode] = useState<ScanMode | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  const refreshPending = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/about-scrape?market=${encodeURIComponent(universeMarket)}`,
      );
      const json = (await res.json()) as { pending?: number };
      setPending(json.pending ?? null);
    } catch {
      /* ignore */
    }
  }, [universeMarket]);

  useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  useEffect(() => {
    if (!progress?.done || progress.error) return;
    const t = setTimeout(() => setProgress(null), 4500);
    return () => clearTimeout(t);
  }, [progress]);

  const runBatches = useCallback(
    async (mode: ScanMode) => {
      if (busyMode) return;
      setBusyMode(mode);

      let gotSaved = 0;
      let gotFailed = 0;
      let gotEmpty = 0;
      let gotTried = 0;
      let lastSaved: string[] = [];
      let remaining =
        mode === "pending" ? (pending ?? 0) : tickers.length;
      let initialTotal = Math.max(
        mode === "pending" ? (pending ?? 0) : tickers.length,
        1,
      );
      const maxRounds =
        mode === "page"
          ? Math.max(1, Math.ceil(tickers.length / BATCH))
          : 40;

      const setWorking = (round: number, phase: "fetch" | "done") => {
        const closed =
          mode === "pending"
            ? Math.max(0, initialTotal - remaining)
            : gotTried;
        const total = initialTotal;
        const pct =
          phase === "fetch"
            ? Math.min(92, Math.round((closed / total) * 100) + 4)
            : remaining <= 0
              ? 100
              : Math.min(96, Math.round((closed / total) * 100));

        const label =
          mode === "page"
            ? phase === "fetch"
              ? `Scan page · batch ${round}`
              : gotTried === 0 && round === 1
                ? "Scan page"
                : "Scan page · done"
            : phase === "fetch"
              ? `Scan pending · batch ${round}`
              : remaining <= 0
                ? "Scan pending · complete"
                : "Scan pending · paused";

        const detail =
          phase === "fetch"
            ? `Fetching ${Math.min(BATCH, remaining)} site${remaining === 1 ? "" : "s"}… · ${formatDetail({
                saved: gotSaved,
                failed: gotFailed,
                empty: gotEmpty,
                remaining,
              })}`
            : formatDetail({
                saved: gotSaved,
                failed: gotFailed,
                empty: gotEmpty,
                remaining,
                savedTickers: lastSaved,
              });

        setProgress({ pct, label, detail });
      };

      try {
        for (let round = 1; round <= maxRounds; round += 1) {
          setWorking(round, "fetch");

          const json = await scrapeOnce({
            market: universeMarket,
            tickers: mode === "page" ? tickers : undefined,
            limit: BATCH,
            pageScan: mode === "page",
            missingOnly: mode === "pending",
          });

          gotSaved += json.saved;
          gotFailed += json.failed;
          gotEmpty += json.empty;
          gotTried += json.tried;
          if (json.saved_tickers?.length) {
            lastSaved = json.saved_tickers;
          }
          remaining = json.remaining;
          if (json.tried > 0 && round === 1) {
            initialTotal = Math.max(initialTotal, json.remaining + gotTried);
          }

          setWorking(round, "done");

          if (json.tried > 0) {
            await onBatch?.();
          }

          if (json.tried === 0) {
            if (round === 1) {
              setProgress({
                pct: 100,
                label: mode === "page" ? "Scan page" : "Scan pending",
                detail:
                  json.message ||
                  (mode === "page"
                    ? "Nothing to scrape on this page"
                    : "Nothing left to scrape"),
                done: true,
              });
            }
            break;
          }

          if (json.done || remaining <= 0) break;
          await new Promise((r) => setTimeout(r, 250));
        }

        if (gotTried > 0) {
          setProgress({
            pct: 100,
            label: "Complete",
            detail: formatDetail({
              saved: gotSaved,
              failed: gotFailed,
              empty: gotEmpty,
              remaining,
              savedTickers: lastSaved,
              suffix: `${listLabel}`,
            }),
            done: true,
          });
        }

        await refreshPending();
        await onDone?.();
      } catch (e) {
        setProgress({
          pct: 100,
          label: "Failed",
          detail:
            e instanceof Error ? e.message : "Website scrape failed",
          error: true,
        });
      } finally {
        setBusyMode(null);
      }
    },
    [
      busyMode,
      listLabel,
      onBatch,
      onDone,
      pending,
      refreshPending,
      tickers,
      universeMarket,
    ],
  );

  const busy = busyMode != null;
  const pageDisabled = busy || tickers.length === 0;
  const pendingDisabled =
    busy || isScanWatchlist(market) || pending == null || pending <= 0;

  return (
    <div className="filter-bar website-scrape-bar">
      <div className="filter-bar-main">
        <span className="chip-label">Websites</span>
        <button
          type="button"
          className={`chip chip-scan ${busyMode === "page" ? "busy" : ""}`}
          disabled={pageDisabled}
          onClick={() => void runBatches("page")}
          title={`Scrape company websites for rows on this page missing stored website text (${listLabel})`}
        >
          {busyMode === "page" ? "Scanning…" : "Scan page"}
          {tickers.length > 0 ? (
            <span className="chip-count">{tickers.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={`chip chip-scan btn-scan-all ${busyMode === "pending" ? "busy" : ""}`}
          disabled={pendingDisabled}
          onClick={() => void runBatches("pending")}
          title={
            isScanWatchlist(market)
              ? "Switch to an exchange list for universe-wide pending scrape"
              : `Scrape Yahoo gaps from company websites (${universeMarket})`
          }
        >
          {busyMode === "pending" ? "Scanning…" : "Scan pending"}
          {pending != null && pending > 0 ? (
            <span className="chip-count">{pending.toLocaleString()}</span>
          ) : null}
        </button>
      </div>

      {busy || progress ? (
        <div
          className={`filter-progress ${progress?.error ? "is-error" : ""} ${progress?.done ? "is-done" : ""}`}
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
            <strong>{progress?.label ?? "Scanning websites"}</strong>
            {progress?.detail ? ` · ${progress.detail}` : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
