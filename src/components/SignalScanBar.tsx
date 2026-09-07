"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CapMarketFilters,
  type CapFilter,
} from "@/components/CapMarketFilters";
import type { FundFilterState } from "@/lib/fund-watchlist-meta";
import { anyFundFilterActive } from "@/lib/fund-watchlist-meta";

export type SignalMode = "all" | "tq" | "bb" | "either" | "both";
export type BbTimeframe = "weekly" | "monthly";
export type ScanScope = "selection" | "list";
export type ViewFilter =
  | "all"
  | "bb"
  | "bbw"
  | "bbm"
  | "tq"
  | "ema"
  | "ath"
  | "high52"
  | "mom"
  | "mrsi"
  | "mrsi85"
  | "mrsi_empty"
  | "opm"
  | "board";

type ScanKind = "bb" | "tq" | "ema" | "ath" | "high52" | "mom" | "mrsi" | "all";
type ExtraBusy = "quarters";

type Props = {
  listLabel: string;
  view: ViewFilter;
  onView: (view: ViewFilter) => void;
  market: string;
  bbTimeframe: BbTimeframe;
  scope: ScanScope;
  onScope: (scope: ScanScope) => void;
  selectionActive: boolean;
  cap?: CapFilter;
  hold?: boolean;
  edge?: boolean;
  quality?: boolean;
  sme?: boolean;
  note?: boolean;
  funds?: FundFilterState;
  onCap?: (cap: CapFilter) => void;
  showCap?: boolean;
  bbCount?: number;
  bbWCount?: number;
  bbMCount?: number;
  tqCount?: number;
  emaCount?: number;
  athCount?: number;
  high52Count?: number;
  momCount?: number;
  mrsiCount?: number;
  mrsi85Count?: number;
  mrsiEmptyCount?: number;
  opmCount?: number;
  boardCount?: number;
  bbDate?: string | null;
  bbWDate?: string | null;
  bbMDate?: string | null;
  tqDate?: string | null;
  emaDate?: string | null;
  athDate?: string | null;
  high52Date?: string | null;
  momDate?: string | null;
  mrsiDate?: string | null;
  onBatch?: () => void | Promise<void>;
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
  let res: Response;
  try {
    res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Network dropped mid-scan. Retry — progress is saved.",
    );
  }
  const raw = await res.text();
  let json: {
    ok?: boolean;
    tried?: number;
    bbHits?: number;
    tqHits?: number;
    emaHits?: number;
    athHits?: number;
    high52Hits?: number;
    momHits?: number;
    momScanned?: number;
    mrsiHits?: number;
    mrsiScanned?: number;
    remaining?: number;
    session?: {
      bb: string | null;
      tq: string | null;
      ema?: string | null;
      ath?: string | null;
      high52?: string | null;
      mom?: string | null;
      mrsi?: string | null;
    };
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
    throw new Error(json.error || `Scan failed (${res.status})`);
  }
  return json;
}

function Count({ n }: { n?: number }) {
  if (n == null) return null;
  return <span className="chip-count">{n}</span>;
}

const SCAN_LABELS: Record<ScanKind, string> = {
  bb: "BB",
  tq: "TQ",
  ema: "EMA",
  ath: "ATH",
  high52: "52W",
  mom: "12m",
  mrsi: "RSI M",
  all: "All",
};

const VIEW_LABELS: Record<ViewFilter, string> = {
  all: "All",
  bb: "BB",
  bbw: "BB W",
  bbm: "BB M",
  tq: "TQ",
  ema: "EMA",
  ath: "ATH",
  high52: "52W",
  mom: "12m",
  mrsi: "RSI M",
  mrsi85: "85–90",
  mrsi_empty: "Empty",
  opm: "Operating Metrics",
  board: "Board",
};

type ScanCounts = {
  bb: number;
  tq: number;
  ema: number;
  ath: number;
  high52: number;
  mom: number;
  mrsi: number;
};

function formatScanProgress(
  kind: ScanKind,
  counts: ScanCounts,
  remaining: number,
  suffix?: string,
  scanned?: { mom?: number; mrsi?: number },
): string {
  const left = `${remaining.toLocaleString()} left`;
  const tail = suffix ? ` · ${suffix}` : "";
  if (kind === "all") {
    return `${counts.bb} BB · ${counts.tq} TQ · ${counts.ema} EMA · ${counts.ath} ATH · ${counts.high52} 52W · ${counts.mom} 12m · ${counts.mrsi} RSI M · ${left}${tail}`;
  }
  if (kind === "bb") return `${counts.bb} BB · ${left}${tail}`;
  if (kind === "tq") return `${counts.tq} TQ · ${left}${tail}`;
  if (kind === "ema") return `${counts.ema} EMA · ${left}${tail}`;
  if (kind === "ath") return `${counts.ath} ATH · ${left}${tail}`;
  if (kind === "high52") return `${counts.high52} 52W · ${left}${tail}`;
  if (kind === "mom") {
    const filled = scanned?.mom ?? 0;
    return `${filled.toLocaleString()} filled · ${counts.mom} +Mom · ${left}${tail}`;
  }
  if (kind === "mrsi") {
    const filled = scanned?.mrsi ?? 0;
    return `${filled.toLocaleString()} filled · ${counts.mrsi} crosses · ${left}${tail}`;
  }
  return `${left}${tail}`;
}

export function viewFilterLabel(view: ViewFilter): string {
  return VIEW_LABELS[view];
}

export function hasScanSelection(opts: {
  cap?: CapFilter;
  hold?: boolean;
  edge?: boolean;
  quality?: boolean;
  sme?: boolean;
  note?: boolean;
  funds?: FundFilterState;
}): boolean {
  if (opts.cap && opts.cap !== "All") return true;
  if (
    opts.hold ||
    opts.edge ||
    opts.quality ||
    opts.sme ||
    opts.note
  )
    return true;
  return anyFundFilterActive(opts.funds ?? {});
}

/** Compact scan + signal filters — same row style as watchlist chips. */
export function SignalScanBar({
  listLabel,
  view,
  onView,
  market,
  bbTimeframe,
  scope,
  onScope,
  selectionActive,
  cap,
  hold,
  edge,
  quality,
  sme,
  note,
  funds,
  onCap,
  showCap,
  bbCount,
  bbWCount,
  bbMCount,
  tqCount,
  emaCount,
  athCount,
  high52Count,
  momCount,
  mrsiCount,
  mrsi85Count,
  mrsiEmptyCount,
  opmCount,
  boardCount,
  bbDate,
  bbWDate,
  bbMDate,
  tqDate,
  emaDate,
  athDate,
  high52Date,
  momDate,
  mrsiDate,
  onBatch,
  onDone,
}: Props) {
  const [busyKind, setBusyKind] = useState<ScanKind | ExtraBusy | null>(null);
  const [busyTf, setBusyTf] = useState<BbTimeframe | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    if (!progress?.done || progress.error) return;
    const t = setTimeout(() => setProgress(null), 3500);
    return () => clearTimeout(t);
  }, [progress]);

  const runScan = useCallback(
    async (kind: ScanKind, tf: BbTimeframe = bbTimeframe) => {
      // Empty chip = RSI M null queue. Scan all there means fill RSI, not BB/TQ/….
      const emptyQueue = view === "mrsi_empty";
      const effectiveKind: ScanKind =
        emptyQueue && (kind === "all" || kind === "mrsi") ? "mrsi" : kind;
      const scopeLabel = emptyQueue
        ? "Empty RSI M"
        : scope === "selection"
          ? listLabel
          : market;
      const scanLabel =
        effectiveKind === "bb"
          ? tf === "monthly"
            ? "BB M"
            : "BB W"
          : emptyQueue && kind === "all"
            ? "RSI M (Empty)"
            : SCAN_LABELS[effectiveKind];
      setBusyKind(kind);
      setBusyTf(kind === "bb" ? tf : null);
      setProgress({
        pct: 2,
        label: `Scanning ${scanLabel}`,
        detail: `${emptyQueue ? "Empty" : scope === "selection" ? "Tags" : "List"} · ${scopeLabel}…`,
      });

      let remaining = 1;
      let gotBb = 0;
      let gotTq = 0;
      let gotEma = 0;
      let gotAth = 0;
      let gotHigh52 = 0;
      let gotMom = 0;
      let gotMrsi = 0;
      let scannedMom = 0;
      let scannedMrsi = 0;
      let clearedEmptyMrsi = false;
      let clearedEmptyMom = false;

      const scanBody = {
        kind: effectiveKind,
        market,
        bbTimeframe: effectiveKind === "bb" ? tf : bbTimeframe,
        limit: 40 as number,
        missingOnly: true,
        scope,
        // Only RSI fills use the never-attempted Empty queue.
        emptyMrsi: emptyQueue && effectiveKind === "mrsi",
        ...(scope === "selection" || (emptyQueue && effectiveKind === "mrsi")
          ? {
              cap: cap ?? "All",
              hold: !!hold,
              edge: !!edge,
              quality: !!quality,
              sme: !!sme,
              note: !!note,
              funds: funds ?? {},
            }
          : {}),
      };

      try {
        for (let round = 1; round <= 200; round += 1) {
          const batchLimit = 40;
          let json: Awaited<ReturnType<typeof scanOnce>> | null = null;
          let attemptError: Error | null = null;
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              json = await scanOnce({
                ...scanBody,
                limit: batchLimit,
                bbTimeframe: effectiveKind === "bb" ? tf : bbTimeframe,
                clearEmptyMrsi:
                  effectiveKind === "mrsi" && !clearedEmptyMrsi,
                clearEmptyMom:
                  (effectiveKind === "mom" || effectiveKind === "all") &&
                  !clearedEmptyMom,
              });
              if (effectiveKind === "mrsi") clearedEmptyMrsi = true;
              if (effectiveKind === "mom" || effectiveKind === "all") {
                clearedEmptyMom = true;
              }
              attemptError = null;
              break;
            } catch (e) {
              attemptError =
                e instanceof Error ? e : new Error("Scan failed");
              if (
                attempt < 3 &&
                /network dropped|failed to fetch|fetch failed/i.test(
                  attemptError.message,
                )
              ) {
                setProgress({
                  pct: Math.min(97, 3 + round * 2),
                  label: `Scanning ${scanLabel}`,
                  detail: `Retry ${attempt}/3 after network drop…`,
                });
                await new Promise((r) => setTimeout(r, 800 * attempt));
                continue;
              }
              throw attemptError;
            }
          }
          if (!json) throw attemptError ?? new Error("Scan failed");
          gotBb += json.bbHits ?? 0;
          gotTq += json.tqHits ?? 0;
          gotEma += json.emaHits ?? 0;
          gotAth += json.athHits ?? 0;
          gotHigh52 += json.high52Hits ?? 0;
          gotMom += json.momHits ?? 0;
          gotMrsi += json.mrsiHits ?? 0;
          scannedMom += json.momScanned ?? json.tried ?? 0;
          scannedMrsi += json.mrsiScanned ?? json.tried ?? 0;
          remaining = json.remaining ?? 0;
          const counts: ScanCounts = {
            bb: gotBb,
            tq: gotTq,
            ema: gotEma,
            ath: gotAth,
            high52: gotHigh52,
            mom: gotMom,
            mrsi: gotMrsi,
          };
          const pct =
            remaining <= 0 ? 100 : Math.min(97, 3 + round * 2);
          setProgress({
            pct,
            label: remaining <= 0 ? "Done" : `Scanning ${scanLabel}`,
            detail: formatScanProgress(
              effectiveKind,
              counts,
              remaining,
              `${emptyQueue ? "Empty" : scope === "selection" ? "Tags" : "List"} · ${scopeLabel}`,
              { mom: scannedMom, mrsi: scannedMrsi },
            ),
            done: remaining <= 0,
          });
          if (
            remaining <= 0 ||
            json.tried === 0 ||
            !onBatch ||
            round === 1 ||
            round % 4 === 0
          ) {
            await (onBatch ?? onDone)?.();
          }
          if (json.tried === 0 || remaining <= 0) break;
          await new Promise((r) => setTimeout(r, 200));
        }

        if (emptyQueue && effectiveKind === "mrsi") onView("mrsi");
        else if (kind === "bb") onView(tf === "monthly" ? "bbm" : "bbw");
        else if (kind === "tq") onView("tq");
        else if (kind === "ema") onView("ema");
        else if (kind === "ath") onView("ath");
        else if (kind === "high52") onView("high52");
        else if (kind === "mom") onView("all");
        else if (kind === "mrsi") onView("mrsi");
        else onView("all");

        setProgress({
          pct: 100,
          label: "Done",
          detail: formatScanProgress(
            effectiveKind,
            {
              bb: gotBb,
              tq: gotTq,
              ema: gotEma,
              ath: gotAth,
              high52: gotHigh52,
              mom: gotMom,
              mrsi: gotMrsi,
            },
            0,
            `${emptyQueue ? "Empty" : scope === "selection" ? "Tags" : "List"} · ${scopeLabel}`,
            { mom: scannedMom, mrsi: scannedMrsi },
          ),
          done: true,
        });
        await onDone?.();
      } catch (e) {
        setProgress({
          pct: 100,
          label: "Failed",
          detail:
            e instanceof Error ? e.message : "Scan failed — try again",
          error: true,
        });
      } finally {
        setBusyKind(null);
        setBusyTf(null);
      }
    },
    [
      market,
      bbTimeframe,
      listLabel,
      scope,
      view,
      cap,
      hold,
      edge,
          quality,
      sme,
      note,
      funds,
      onBatch,
      onDone,
      onView,
    ],
  );

  const selectionBody = useCallback(
    () =>
      scope === "selection"
        ? {
            scope: "selection" as const,
            cap: cap ?? "All",
            hold: !!hold,
            edge: !!edge,
            quality: !!quality,
            sme: !!sme,
            note: !!note,
            funds: funds ?? {},
          }
        : { scope: "list" as const },
    [scope, cap, hold, edge, quality, sme, note, funds],
  );

  const runQuartersFill = useCallback(async () => {
    const scopeLabel = scope === "selection" ? listLabel : market;
    setBusyKind("quarters");
    setBusyTf(null);
    setProgress({
      pct: 2,
      label: "Fill Quarters",
      detail: `${scope === "selection" ? "Tags" : "List"} · ${scopeLabel} · missing-only…`,
    });
    let remaining = 1;
    let saved = 0;
    let failed = 0;

    async function postBatch(round: number): Promise<{
      ok?: boolean;
      tried?: number;
      saved?: number;
      failed?: number;
      remaining?: number;
      message?: string;
      error?: string;
    }> {
      const maxAttempts = 3;
      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const res = await fetch("/api/quarters-fill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              market,
              limit: 8,
              concurrency: 2,
              missingOnly: true,
              ...selectionBody(),
            }),
            signal: AbortSignal.timeout(120_000),
          });
          const json = (await res.json()) as {
            ok?: boolean;
            tried?: number;
            saved?: number;
            failed?: number;
            remaining?: number;
            message?: string;
            error?: string;
          };
          if (!res.ok || json.ok === false) {
            throw new Error(
              json.error || json.message || "Quarters fill failed",
            );
          }
          return json;
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
          const msg = lastErr.message || "";
          const retryable =
            /failed to fetch|networkerror|load failed|aborted|timeout|timed out/i.test(
              msg,
            ) ||
            lastErr.name === "TimeoutError" ||
            lastErr.name === "AbortError";
          if (!retryable || attempt === maxAttempts) break;
          setProgress({
            pct: Math.min(97, 3 + round * 2),
            label: "Fill Quarters",
            detail: `Reconnect ${attempt}/${maxAttempts - 1}… · ${scopeLabel}`,
          });
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
      throw lastErr ?? new Error("Quarters fill failed");
    }

    try {
      for (let round = 1; round <= 300; round += 1) {
        const json = await postBatch(round);
        saved += json.saved ?? 0;
        failed += json.failed ?? 0;
        remaining = json.remaining ?? 0;
        setProgress({
          pct: remaining <= 0 ? 100 : Math.min(97, 3 + round * 2),
          label: remaining <= 0 ? "Done" : "Fill Quarters",
          detail: `+${saved} cached · ${failed} failed · ${remaining.toLocaleString()} left · ${scopeLabel}`,
          done: remaining <= 0,
        });
        if (round === 1 || round % 3 === 0 || remaining <= 0) {
          await (onBatch ?? onDone)?.();
        }
        if ((json.tried ?? 0) === 0 || remaining <= 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      setProgress({
        pct: 100,
        label: "Done",
        detail: `+${saved} quarters · ${failed} failed · ${scopeLabel}`,
        done: true,
      });
      onView("opm");
      await onDone?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Quarters fill failed";
      const nicer = /failed to fetch|networkerror|load failed/i.test(msg)
        ? "Server disconnected — try Fill Quarters again (dev may have restarted)"
        : /aborted|timeout|timed out/i.test(msg)
          ? "Timed out — try a smaller List/Tags scope, then Fill Quarters again"
          : msg;
      setProgress({
        pct: 100,
        label: "Failed",
        detail: nicer,
        error: true,
      });
    } finally {
      setBusyKind(null);
    }
  }, [
    market,
    listLabel,
    scope,
    selectionBody,
    onBatch,
    onDone,
    onView,
  ]);

  const busy = busyKind != null;

  const progressEl =
    busy || progress ? (
      <div
        className={`filter-progress ${progress?.error ? "is-error" : ""} ${progress?.done ? "is-done" : ""}`}
        role="status"
        aria-live="polite"
      >
        <div className="filter-progress-track">
          <div
            className="filter-progress-fill"
            style={{ width: `${progress?.pct ?? (busy ? 8 : 0)}%` }}
          />
        </div>
        <span className="filter-progress-text">
          <strong>{progress?.label ?? "Scanning"}</strong>
          {progress?.detail ? ` · ${progress.detail}` : null}
        </span>
      </div>
    ) : null;

  return (
    <>
      <div className="scan-filter-row">
        <span className="scan-filter-label">Signals</span>
        <div className="filter-bar scan-signal-bar">
          <div className="filter-bar-main">
            {showCap && onCap && cap != null ? (
              <>
                <CapMarketFilters cap={cap} onCap={onCap} inline />
                <span className="filter-sep" aria-hidden />
              </>
            ) : null}

            <button
              type="button"
              className={`chip tag-chip ${view === "all" ? "on" : ""}`}
              onClick={() => onView("all")}
              title="Full list"
            >
              All
            </button>
            <button
              type="button"
              className={`chip tag-chip tag-scan-bb-w ${view === "bbw" ? "on" : ""}`}
              onClick={() => onView("bbw")}
              title={
                bbWDate || bbDate
                  ? `Weekly BB NEW · ${bbWDate || bbDate}`
                  : "Weekly BB NEW hits"
              }
            >
              BB W
              <Count n={bbWCount ?? bbCount} />
              {bbWDate || bbDate ? (
                <span className="chip-date">
                  {(bbWDate || bbDate)!.slice(5)}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className={`chip tag-chip tag-scan-bb-m ${view === "bbm" ? "on" : ""}`}
              onClick={() => onView("bbm")}
              title={
                bbMDate
                  ? `Monthly BB NEW · ${bbMDate}`
                  : "Monthly BB NEW hits"
              }
            >
              BB M
              <Count n={bbMCount} />
              {bbMDate ? (
                <span className="chip-date">{bbMDate.slice(5)}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`chip tag-chip tag-scan-tq ${view === "tq" ? "on" : ""}`}
              onClick={() => onView("tq")}
              title={tqDate ? `Weekly TQ · ${tqDate}` : "Weekly TQ hits"}
            >
              TQ
              <Count n={tqCount} />
              {tqDate ? (
                <span className="chip-date">{tqDate.slice(5)}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`chip tag-chip tag-scan-ema ${view === "ema" ? "on" : ""}`}
              onClick={() => onView("ema")}
              title={
                emaDate
                  ? `Daily EMA · ${emaDate}`
                  : "Daily EMA stack hits"
              }
            >
              EMA
              <Count n={emaCount} />
              {emaDate ? (
                <span className="chip-date">{emaDate.slice(5)}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`chip tag-chip tag-scan-ath ${view === "ath" ? "on" : ""}`}
              onClick={() => onView("ath")}
              title={
                athDate ? `NEW ATH · ${athDate}` : "NEW all-time high hits"
              }
            >
              ATH
              <Count n={athCount} />
              {athDate ? (
                <span className="chip-date">{athDate.slice(5)}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`chip tag-chip tag-scan-high52 ${view === "high52" ? "on" : ""}`}
              onClick={() => onView("high52")}
              title={
                high52Date
                  ? `NEW 52W high · ${high52Date}`
                  : "NEW 52-week high hits"
              }
            >
              52W
              <Count n={high52Count} />
              {high52Date ? (
                <span className="chip-date">{high52Date.slice(5)}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`chip tag-chip tag-scan-mrsi ${view === "mrsi" ? "on" : ""}`}
              onClick={() => onView("mrsi")}
              title={
                mrsiDate
                  ? `Monthly RSI cross above 70 · ${mrsiDate}`
                  : "Monthly RSI(14) new cross above 70"
              }
            >
              RSI M
              <Count n={mrsiCount} />
              {mrsiDate ? (
                <span className="chip-date">{mrsiDate.slice(5)}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`chip tag-chip tag-scan-mrsi85 ${view === "mrsi85" ? "on" : ""}`}
              onClick={() => onView("mrsi85")}
              title="Monthly RSI 85–90 — excellent momentum window (scanned universe)"
            >
              85–90
              <Count n={mrsi85Count} />
            </button>
            {(mrsiEmptyCount ?? 0) > 0 ? (
              <button
                type="button"
                className={`chip tag-chip tag-scan-mrsi-empty ${view === "mrsi_empty" ? "on" : ""}`}
                onClick={() => onView("mrsi_empty")}
                title="Stocks with no RSI M value yet — select Empty, then Scan RSI M to fill data; filter switches to RSI M when done"
              >
                Empty
                <Count n={mrsiEmptyCount} />
              </button>
            ) : null}

            <button
              type="button"
              className={`chip tag-chip tag-scan-opm ${view === "opm" ? "on" : ""}`}
              onClick={() => onView("opm")}
              title="Operating Metrics: Stable OPM (range ≤2.5pp) and Sales YoY ≥5%. New listings (2–3Q): Stable OPM + QoQ sales growth when YoY is not available yet."
            >
              Operating Metrics
              <Count n={opmCount} />
            </button>

            <button
              type="button"
              className={`chip tag-chip tag-scan-board ${view === "board" ? "on" : ""}`}
              onClick={() => onView("board")}
              title="Board reputation: DIN-backed directors with cap bridge, Multi-LC, SME×mainboard, or strong multi-board score. Uses local governance.db — no separate Scan button."
            >
              Board
              <Count n={boardCount} />
            </button>

            {view !== "all" ? (
              <button
                type="button"
                className="clear-filter"
                onClick={() => onView("all")}
                title="Show full list"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="scan-filter-row">
        <span className="scan-filter-label">Scan</span>
        <div className="filter-bar scan-signal-bar">
          <div className="scan-actions">
            <button
              type="button"
              className={`chip tag-chip tag-scan-scope ${scope === "selection" ? "on" : ""}`}
              disabled={busy || !selectionActive}
              onClick={() => onScope("selection")}
              title={
                selectionActive
                  ? `Scan only the active tags (e.g. Edge, Quality, Hold, Cap) within ${market}`
                  : "Select a Lists or Funds tag (Edge, Quality, Hold, Cap, …) first"
              }
            >
              Tags
            </button>
            <button
              type="button"
              className={`chip tag-chip tag-scan-scope ${scope === "list" ? "on" : ""}`}
              disabled={busy}
              onClick={() => onScope("list")}
              title={`Scan the full List dropdown (${market}), ignoring Lists tags`}
            >
              List
            </button>
            <span className="filter-sep" aria-hidden />
            {(
              [
                {
                  kind: "bb" as const,
                  tf: "weekly" as const,
                  label: "Scan BB W",
                },
                {
                  kind: "bb" as const,
                  tf: "monthly" as const,
                  label: "Scan BB M",
                },
                { kind: "tq" as const, label: "Scan TQ" },
                { kind: "ema" as const, label: "Scan EMA" },
                { kind: "ath" as const, label: "Scan ATH" },
                { kind: "high52" as const, label: "Scan 52W" },
                { kind: "mom" as const, label: "Scan 12m" },
                { kind: "mrsi" as const, label: "Scan RSI M" },
                { kind: "all" as const, label: "Scan all" },
              ] as const
            ).map((btn) => {
              const tf = "tf" in btn ? btn.tf : undefined;
              const isThisBusy =
                busyKind === btn.kind &&
                (btn.kind !== "bb" || busyTf === tf);
              const target =
                scope === "selection" ? listLabel : market;
              return (
                <button
                  key={btn.label}
                  type="button"
                  className={`chip chip-scan tag-chip ${isThisBusy ? "busy on" : ""}`}
                  disabled={
                    busy || (scope === "selection" && !selectionActive)
                  }
                  onClick={() => void runScan(btn.kind, tf ?? bbTimeframe)}
                  title={
                    btn.kind === "bb"
                      ? `Scan ${tf === "monthly" ? "monthly" : "weekly"} BB on ${target}`
                      : btn.kind === "mom"
                        ? `Scan 12−1 momentum (fills 1Y / 1M / Mom) on ${target}`
                      : btn.kind === "mrsi"
                          ? view === "mrsi_empty"
                            ? `Fill RSI M values for Empty queue, then apply RSI M filter (cross above 70)`
                            : `Scan monthly RSI(14); fill values + filter = new cross above 70 on ${target}`
                          : btn.kind === "all"
                          ? view === "mrsi_empty"
                            ? `Fill Empty RSI M queue (same as Scan RSI M)`
                            : `Scan BB W, TQ, EMA, ATH, 52W, 12m, RSI M on ${target}`
                          : `Scan ${SCAN_LABELS[btn.kind]} on ${target}`
                  }
                >
                  {isThisBusy ? "…" : btn.label}
                </button>
              );
            })}
            <span className="filter-sep" aria-hidden />
            <button
              type="button"
              className={`chip chip-scan tag-chip ${busyKind === "quarters" ? "busy on" : ""}`}
              disabled={busy || (scope === "selection" && !selectionActive)}
              onClick={() => void runQuartersFill()}
              title={`Fill missing quarterly Sales/OP (for Operating Metrics) on ${scope === "selection" ? listLabel : market} — missing-only`}
            >
              {busyKind === "quarters" ? "…" : "Fill Quarters"}
            </button>
          </div>
          {progressEl}
        </div>
      </div>
    </>
  );
}
