"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshButton } from "@/components/RefreshButton";
import {
  StrategyConcallDriftRow,
  type StrategyConcallDriftRowData,
} from "@/components/StrategyConcallDriftRow";
import type { StrategyExpandPanel } from "@/components/StrategyExpandDetail";
import {
  ConcallDriftFilterBar,
  defaultCustomDates,
  type ConcallDriftDatePreset,
  type ConcallDriftSort,
} from "@/components/ConcallDriftFilterBar";
import { recentFyQuarterOptions, currentEarnSeasonQuarter } from "@/lib/strategy/concall-drift-quarters";
import { LiveNseFeedBadge } from "@/components/LiveNseFeedBadge";
import type { NseFeedStatus } from "@/lib/nse-feed-status-types";
import { parseFetchJson } from "@/lib/fetch-json";

const DEFAULT_CUSTOM = defaultCustomDates();
const KIND = "concall_drift" as const;

type ApiResponse = {
  kind: typeof KIND;
  stats: Record<string, number>;
  pending: number;
  quarters?: string[];
  sectors?: string[];
  mcap_bounds?: { min: number; max: number };
  total_events?: number;
  with_baseline?: number;
  scan_progress?: { pending: number; scanned: number; universe: number };
  nse_feed?: NseFeedStatus;
  rows: StrategyConcallDriftRowData[];
};

type ScanJson = {
  tried?: number;
  saved?: number;
  failed?: number;
  remaining?: number;
  scanned?: number;
  universe?: number;
  done?: boolean;
  announced?: number;
  remaining_tickers?: string[];
  message?: string;
  error?: string;
};

const SCAN_TIMEOUT_MS = 240_000;

async function scanOnce(body: Record<string, unknown>): Promise<ScanJson> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch("/api/strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
      });
      const json = await parseFetchJson<ScanJson>(res);
      if (!res.ok) throw new Error(json.error || "Scan failed");
      return json;
    } catch (e) {
      lastErr = e;
      if (
        attempt === 0 &&
        e instanceof Error &&
        /fetch|network|abort|timeout/i.test(`${e.name} ${e.message}`)
      ) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      break;
    }
  }
  const err = lastErr instanceof Error ? lastErr : new Error("Scan failed");
  if (err.message === "Failed to fetch" || err.name === "TimeoutError") {
    throw new Error(
      "Scan request lost — server may be busy. Click Scan again to continue.",
    );
  }
  throw err;
}

function friendlyScanError(e: unknown): string {
  if (!(e instanceof Error)) return "Scan failed";
  if (e.message === "Failed to fetch" || e.name === "TimeoutError") {
    return "Scan request lost — server may be busy. Click Scan again to continue.";
  }
  return e.message;
}

type ScanProgress = {
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
};

function StrategyScanBar({
  market,
  busy,
  ready,
  onRefresh,
}: {
  market: string;
  busy: boolean;
  ready: boolean;
  onRefresh: (opts?: { silent?: boolean; refresh?: boolean }) => void | Promise<void>;
}) {
  const [scanBusy, setScanBusy] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);

  const run = useCallback(async () => {
    if (scanBusy || busy) return;

    setScanBusy(true);
    if (progress?.error) {
      setProgress({
        pct: Math.max(progress.pct, 2),
        label: "Retrying",
        detail: "Fetching NSE announcements…",
      });
    } else {
      setProgress({
        pct: 4,
        label: "Announcements",
        detail: "Reading NSE filings from the last 7 days…",
      });
    }

    const softRefresh = async () => {
      try {
        await onRefresh({ silent: true });
      } catch {
        /* keep going */
      }
    };

    try {
      let round = 0;
      let totalSaved = 0;
      let totalFailed = 0;
      let leftover: string[] | null = null;
      let universe = 0;

      for (;;) {
        round += 1;
        setProgress({
          pct: leftover
            ? Math.min(96, 12 + round * 18)
            : 8,
          label: leftover ? "Fetching" : "Announcements",
          detail: leftover
            ? `Batch ${round} · ${leftover.length.toLocaleString()} announced left…`
            : "Pulling today’s earn / concall filings…",
        });

        const json = await scanOnce({
          kind: KIND,
          market,
          limit: 24,
          concurrency: 4,
          announced: leftover == null,
          announcedDays: 7,
          tickers: leftover ?? undefined,
        });

        leftover = json.remaining_tickers?.length ? json.remaining_tickers : [];
        if (json.universe) universe = json.universe;
        totalSaved += json.saved ?? 0;
        totalFailed += json.failed ?? 0;

        const scanned = json.scanned ?? totalSaved;
        const uni = json.universe || universe;
        const pct =
          uni > 0 ? Math.min(99, Math.round((100 * scanned) / uni)) : json.tried ? 70 : 100;

        setProgress({
          pct,
          label: "Announcements",
          detail: `${scanned.toLocaleString()} / ${uni.toLocaleString()} announced${
            json.remaining ? ` · ${json.remaining} left` : ""
          }${totalFailed ? ` · ${totalFailed} failed` : ""}`,
        });

        await softRefresh();

        if ((json.tried ?? 0) === 0 || json.done || leftover.length === 0) {
          setProgress({
            pct: 100,
            label: json.tried ? "Updated" : "Up to date",
            detail:
              json.message ||
              (uni
                ? `${uni.toLocaleString()} announced names`
                : "No earn/concall filings in the last 7 days"),
            done: true,
          });
          break;
        }
      }

      try {
        await onRefresh({ refresh: true });
      } catch {
        /* rows already saved */
      }
    } catch (e) {
      setProgress({
        pct: progress?.pct ?? 0,
        label: "Failed",
        detail: friendlyScanError(e),
        error: true,
      });
    } finally {
      setScanBusy(false);
    }
  }, [busy, market, onRefresh, progress?.error, progress?.pct, scanBusy]);

  const label = scanBusy
    ? "Fetching…"
    : progress?.error
      ? "Retry"
      : "Get announced";

  const showProgress = scanBusy || progress?.error;

  return (
    <div className="filter-bar strategy-scan-bar">
      <div className="filter-bar-main strategy-scan-actions">
        <button
          type="button"
          className={`chip chip-scan ${scanBusy ? "busy" : ""}`}
          disabled={scanBusy || busy || !ready}
          title="Pull companies that filed results or a concall on NSE (last 7 days)"
          onClick={() => void run()}
        >
          {label}
        </button>
      </div>

      {showProgress ? (
        <div
          className={`filter-progress ${progress?.error ? "is-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className="filter-progress-track">
            <div
              className="filter-progress-fill"
              style={{
                width: `${progress?.pct ?? 8}%`,
              }}
            />
          </div>
          <span className="filter-progress-text">
            <strong>{progress?.label ?? "Fetching"}</strong>
            {progress?.detail ? ` · ${progress.detail}` : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function StrategyPanel() {
  const [market, setMarket] = useState("All");
  const [driftSort, setDriftSort] = useState<ConcallDriftSort>("all");
  const [datePreset, setDatePreset] = useState<ConcallDriftDatePreset>("");
  const [quarter, setQuarter] = useState(currentEarnSeasonQuarter);
  const [customFrom, setCustomFrom] = useState(DEFAULT_CUSTOM.from);
  const [customTo, setCustomTo] = useState(DEFAULT_CUSTOM.to);
  const [sector, setSector] = useState("");
  const [mcapMin, setMcapMin] = useState<number | null>(null);
  const [mcapMax, setMcapMax] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandPanel, setExpandPanel] = useState<StrategyExpandPanel>("qtr");

  const rowIdentity = useMemo(
    () => (data?.rows ?? []).map((r) => `${r.market}:${r.ticker}`).join("|"),
    [data?.rows],
  );

  useEffect(() => {
    setExpanded(null);
    setExpandPanel("qtr");
  }, [rowIdentity]);

  const load = useCallback(async (opts?: { refresh?: boolean; silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({
        kind: KIND,
        market,
        cap: "All",
      });
      if (quarter) params.set("quarter", quarter);
      if (datePreset) params.set("window", datePreset);
      params.set("sort", driftSort);
      if (search.trim()) params.set("q", search.trim());
      if (sector) params.set("sector", sector);
      if (datePreset === "custom") {
        if (customFrom) params.set("from", customFrom);
        if (customTo) params.set("to", customTo);
      }
      if (mcapMin != null) params.set("mcapMin", String(mcapMin));
      if (mcapMax != null) params.set("mcapMax", String(mcapMax));
      if (opts?.refresh) params.set("refresh", "1");
      const res = await fetch(`/api/strategy?${params}`, {
        signal: AbortSignal.timeout(120_000),
      });
      const json = await parseFetchJson<ApiResponse & { error?: string }>(res);
      if (!res.ok || json.error) throw new Error(json.error || `Load failed (${res.status})`);
      setData(json);
    } catch (err) {
      const msg =
        err instanceof Error
          ? /abort|timeout/i.test(`${err.name} ${err.message}`)
            ? "Request timed out — try again or narrow filters"
            : err.message
          : "Failed to load";
      setLoadError(msg);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [
    market,
    quarter,
    datePreset,
    driftSort,
    search,
    sector,
    customFrom,
    customTo,
    mcapMin,
    mcapMax,
  ]);

  useEffect(() => {
    if (!data?.mcap_bounds) return;
    setMcapMin((cur) => (cur == null ? data.mcap_bounds!.min : cur));
    setMcapMax((cur) => (cur == null ? data.mcap_bounds!.max : cur));
  }, [data?.mcap_bounds]);

  useEffect(() => {
    setMcapMin(null);
    setMcapMax(null);
  }, [quarter, market]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.rows ?? [];
  const dataReady = data?.kind === KIND && !loading;

  return (
    <div className="panel strategy-panel">
      <div className="missing-head">
        <div>
          <div className="missing-head-title-row">
            <h2>Concall</h2>
            <LiveNseFeedBadge status={data?.nse_feed} />
          </div>
          <p className="missing-sub">
            NSE-filed results and concalls — drift from prior close to CMP
            {data ? (
              <> · <strong>{rows.length.toLocaleString()}</strong> shown</>
            ) : null}
          </p>
        </div>
        <div className="missing-head-actions">
          <RefreshButton busy={loading} onRefresh={() => void load({ refresh: true })} />
        </div>
      </div>

      <div className="toolbar strategy-toolbar">
        <label className="field">
          <span>List</span>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="All">All</option>
            <option value="NSE">NSE</option>
            <option value="NSE SME">NSE SME</option>
            <option value="BSE SME">BSE SME</option>
          </select>
        </label>
      </div>

      <ConcallDriftFilterBar
        sort={driftSort}
        onSort={setDriftSort}
        datePreset={datePreset}
        onDatePreset={setDatePreset}
        quarter={quarter}
        onQuarter={setQuarter}
        quarterOptions={data?.quarters ?? recentFyQuarterOptions()}
        customFrom={customFrom}
        customTo={customTo}
        onCustomFrom={setCustomFrom}
        onCustomTo={setCustomTo}
        sector={sector}
        onSector={setSector}
        sectors={data?.sectors ?? []}
        mcapMin={mcapMin}
        mcapMax={mcapMax}
        onMcapMin={setMcapMin}
        onMcapMax={setMcapMax}
        mcapBounds={data?.mcap_bounds ?? null}
        search={search}
        onSearch={setSearch}
        withBaseline={data?.with_baseline}
        totalEvents={data?.total_events}
        nseFeed={data?.nse_feed}
      />

      <StrategyScanBar
        market={market}
        busy={loading}
        ready={dataReady}
        onRefresh={load}
      />

      <p className="hint tight">
        <strong>Get announced</strong> pulls companies that just filed results or a concall
        on NSE (last 7 days) — not the whole universe. Expand a row for Qtr, Documents, and Highlights.
      </p>

      {loading && !data ? <div className="loading">Loading…</div> : null}

      {loadError ? (
        <div className="empty-state empty-state-error">{loadError}</div>
      ) : null}

      {!loading && !loadError && rows.length === 0 ? (
        <div className="empty-state">
          {datePreset ? (
            <>
              No earn events for this date filter — clear the date preset or
              widen the quarter.
            </>
          ) : (
            <>
              No rows yet — click <strong>Get announced</strong> to pull today’s
              NSE result / concall filings.
            </>
          )}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="table-card strategy-table-card">
          <div className="table-wrap">
            <table className="data-table strategy-data-table cd-board">
              <thead>
                <tr>
                  <th className="cd-idx-h">#</th>
                  <th>Company</th>
                  <th className="cd-date-h">Date</th>
                  <th className="num">LTP</th>
                  <th className="num">Drift</th>
                  <th className="col-links">Links</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const key = `${r.market}:${r.ticker}`;
                  const open = expanded === key;
                  return (
                    <StrategyConcallDriftRow
                      key={key}
                      index={i + 1}
                      row={r}
                      open={open}
                      panel={expandPanel}
                      onToggle={() =>
                        setExpanded((cur) => {
                          if (cur === key) return null;
                          setExpandPanel("qtr");
                          return key;
                        })
                      }
                      onPanel={setExpandPanel}
                      onDocsChange={() => void load({ silent: true })}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
