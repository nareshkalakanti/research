"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CapMarketFilters,
  type CapFilter,
} from "@/components/CapMarketFilters";

export type SignalMode = "all" | "tq" | "bb" | "either" | "both";
export type BbTimeframe = "weekly" | "monthly";
export type ViewFilter = "all" | "bb" | "tq" | "ema";

type ScanKind = "bb" | "tq" | "ema" | "all";

type Props = {
  listLabel: string;
  view: ViewFilter;
  onView: (view: ViewFilter) => void;
  market: string;
  bbTimeframe: BbTimeframe;
  cap?: CapFilter;
  onCap?: (cap: CapFilter) => void;
  showCap?: boolean;
  bbCount?: number;
  tqCount?: number;
  emaCount?: number;
  bbDate?: string | null;
  tqDate?: string | null;
  emaDate?: string | null;
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
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json: {
    ok?: boolean;
    tried?: number;
    bbHits?: number;
    tqHits?: number;
    emaHits?: number;
    remaining?: number;
    session?: { bb: string | null; tq: string | null; ema?: string | null };
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
  all: "All",
};

/** Compact scan + signal filters — same row style as watchlist chips. */
export function SignalScanBar({
  listLabel,
  view,
  onView,
  market,
  bbTimeframe,
  cap,
  onCap,
  showCap,
  bbCount,
  tqCount,
  emaCount,
  bbDate,
  tqDate,
  emaDate,
  onBatch,
  onDone,
}: Props) {
  const [busyKind, setBusyKind] = useState<ScanKind | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    if (!progress?.done || progress.error) return;
    const t = setTimeout(() => setProgress(null), 3500);
    return () => clearTimeout(t);
  }, [progress]);

  const runScan = useCallback(
    async (kind: ScanKind) => {
      setBusyKind(kind);
      setProgress({
        pct: 2,
        label: `Scanning ${SCAN_LABELS[kind]}`,
        detail: `${listLabel}…`,
      });

      let remaining = 1;
      let gotBb = 0;
      let gotTq = 0;
      let gotEma = 0;

      try {
        for (let round = 1; round <= 120; round += 1) {
          const json = await scanOnce({
            kind,
            market,
            bbTimeframe,
            limit: 40,
            missingOnly: true,
          });
          gotBb += json.bbHits ?? 0;
          gotTq += json.tqHits ?? 0;
          gotEma += json.emaHits ?? 0;
          remaining = json.remaining ?? 0;
          const pct =
            remaining <= 0 ? 100 : Math.min(97, 3 + round * 2);
          setProgress({
            pct,
            label: remaining <= 0 ? "Done" : `Scanning ${SCAN_LABELS[kind]}`,
            detail: `${gotBb} BB · ${gotTq} TQ · ${gotEma} EMA · ${remaining.toLocaleString()} left`,
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

        if (kind === "bb") onView("bb");
        else if (kind === "tq") onView("tq");
        else if (kind === "ema") onView("ema");
        else onView("all");

        setProgress({
          pct: 100,
          label: "Done",
          detail: `${gotBb} BB · ${gotTq} TQ · ${gotEma} EMA · ${listLabel}`,
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
      }
    },
    [market, bbTimeframe, listLabel, onBatch, onDone, onView],
  );

  const busy = busyKind != null;
  const bbTfLabel = bbTimeframe === "monthly" ? "monthly" : "weekly";

  return (
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
          className={`chip tag-chip tag-scan-bb ${view === "bb" ? "on" : ""}`}
          onClick={() => onView("bb")}
          title={
            bbDate
              ? `${bbTfLabel} BB NEW · ${bbDate}`
              : `${bbTfLabel} BB NEW hits`
          }
        >
          BB
          <Count n={bbCount} />
          {bbDate ? <span className="chip-date">{bbDate.slice(5)}</span> : null}
        </button>
        <button
          type="button"
          className={`chip tag-chip tag-scan-tq ${view === "tq" ? "on" : ""}`}
          onClick={() => onView("tq")}
          title={tqDate ? `Weekly TQ · ${tqDate}` : "Weekly TQ hits"}
        >
          TQ
          <Count n={tqCount} />
          {tqDate ? <span className="chip-date">{tqDate.slice(5)}</span> : null}
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

        <span className="filter-sep scan-actions-sep" aria-hidden />

        <div className="scan-actions">
          {(["bb", "tq", "ema", "all"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`chip chip-scan ${busyKind === kind ? "busy" : ""}`}
              disabled={busy}
              onClick={() => void runScan(kind)}
              title={
                kind === "bb"
                  ? `Scan ${bbTfLabel} BB on ${listLabel}`
                  : kind === "all"
                    ? `Scan BB, TQ, EMA on ${listLabel}`
                    : `Scan ${kind.toUpperCase()} on ${listLabel}`
              }
            >
              {busyKind === kind
                ? "…"
                : kind === "all"
                  ? "Scan all"
                  : `Scan ${kind.toUpperCase()}`}
            </button>
          ))}
        </div>
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
              style={{ width: `${progress?.pct ?? (busy ? 8 : 0)}%` }}
            />
          </div>
          <span className="filter-progress-text">
            <strong>{progress?.label ?? "Scanning"}</strong>
            {progress?.detail ? ` · ${progress.detail}` : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
