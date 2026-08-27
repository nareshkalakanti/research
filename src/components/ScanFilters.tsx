"use client";

import { useCallback, useState } from "react";
import {
  CapMarketFilters,
  type CapFilter,
} from "@/components/CapMarketFilters";

/** Quant signal toolbar modes. */
export type SignalMode = "all" | "tq" | "bb" | "either" | "both";

type Props = {
  cap?: CapFilter;
  onCap?: (cap: CapFilter) => void;
  /** Unified signal filter. When set, drives BB/TQ chips. */
  signal?: SignalMode;
  onSignal?: (mode: SignalMode) => void;
  bb: boolean;
  tq: boolean;
  onBb: (on: boolean) => void;
  onTq: (on: boolean) => void;
  ema?: boolean;
  onEma?: (on: boolean) => void;
  hold?: boolean;
  onHold?: (on: boolean) => void;
  distressCount?: number;
  edge?: boolean;
  onEdge?: (on: boolean) => void;
  niveshaay?: boolean;
  onNiveshaay?: (on: boolean) => void;
  negen?: boolean;
  onNegen?: (on: boolean) => void;
  kacholia?: boolean;
  onKacholia?: (on: boolean) => void;
  sme?: boolean;
  onSme?: (on: boolean) => void;
  note?: boolean;
  onNote?: (on: boolean) => void;
  bbCount?: number;
  tqCount?: number;
  emaCount?: number;
  holdCount?: number;
  edgeCount?: number;
  niveshaayCount?: number;
  negenCount?: number;
  kacholiaCount?: number;
  smeCount?: number;
  noteCount?: number;
  bbDate?: string | null;
  tqDate?: string | null;
  emaDate?: string | null;
  market: string;
  /** Called after each scan batch (live count refresh). */
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

function weekStamp(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return iso;
  const day = d.getUTCDate();
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `week Fri ${day} ${mon}`;
}

function Count({ n }: { n?: number }) {
  if (n == null) return null;
  return <span className="chip-count">{n}</span>;
}

/** Cap + watchlists + weekly BB/TQ — one compact toolbar row. */
export function ScanFilters({
  cap,
  onCap,
  signal,
  onSignal,
  bb,
  tq,
  onBb,
  onTq,
  ema = false,
  onEma,
  hold = false,
  onHold,
  edge = false,
  onEdge,
  niveshaay = false,
  onNiveshaay,
  negen = false,
  onNegen,
  kacholia = false,
  onKacholia,
  sme = false,
  onSme,
  note = false,
  onNote,
  bbCount,
  tqCount,
  emaCount,
  holdCount,
  distressCount,
  edgeCount,
  niveshaayCount,
  negenCount,
  kacholiaCount,
  smeCount,
  noteCount,
  bbDate,
  tqDate,
  emaDate,
  market,
  onBatch,
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  const runScan = useCallback(async () => {
    setBusy(true);
    setProgress({ pct: 2, label: "Scanning", detail: "Starting BB/TQ/EMA…" });

    let remaining = 1;
    let gotBb = 0;
    let gotTq = 0;
    let gotEma = 0;
    let sessionLabel = "";

    try {
      for (let round = 1; round <= 120; round += 1) {
        const json = await scanOnce({
          kind: "all",
          market,
          limit: 40,
          missingOnly: true,
        });
        gotBb += json.bbHits ?? 0;
        gotTq += json.tqHits ?? 0;
        gotEma += json.emaHits ?? 0;
        remaining = json.remaining ?? 0;
        if (json.session?.bb || json.session?.tq || json.session?.ema) {
          const iso =
            json.session.ema || json.session.bb || json.session.tq || "";
          sessionLabel = iso ? weekStamp(iso) : "";
        }
        const pct =
          remaining <= 0 ? 100 : Math.min(97, 3 + round * 2);
        setProgress({
          pct,
          label: remaining <= 0 ? "Done" : "Scanning BB/TQ/EMA",
          detail: `${gotBb} BB · ${gotTq} TQ · ${gotEma} EMA · ${remaining.toLocaleString()} left${
            sessionLabel ? ` · ${sessionLabel}` : ""
          }`,
          done: remaining <= 0,
        });
        await (onBatch ?? onDone)?.();
        if (json.tried === 0 || remaining <= 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      onSignal?.("either");
      if (!onSignal) {
        onBb(true);
        onTq(true);
        onEma?.(true);
      }
      setProgress({
        pct: 100,
        label: "Done",
        detail: `${gotBb} BB · ${gotTq} TQ · ${gotEma} EMA${
          sessionLabel ? ` · ${sessionLabel}` : ""
        }`,
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
      setBusy(false);
    }
  }, [market, onBatch, onDone, onBb, onTq, onEma, onSignal]);

  const holdTitle =
    distressCount && distressCount > 0
      ? `Holdings (${holdCount ?? 0}) · ${distressCount} distress monitors`
      : "Your holdings";

  const filtersActive =
    (cap != null && cap !== "All") ||
    hold ||
    edge ||
    niveshaay ||
    negen ||
    kacholia ||
    sme ||
    note ||
    bb ||
    tq ||
    ema ||
    (signal != null && signal !== "all");

  const clearFilters = () => {
    onCap?.("All");
    onHold?.(false);
    onEdge?.(false);
    onNiveshaay?.(false);
    onNegen?.(false);
    onKacholia?.(false);
    onSme?.(false);
    onNote?.(false);
    onBb(false);
    onTq(false);
    onEma?.(false);
    onSignal?.("all");
  };

  return (
    <div className="filter-bar">
      <div className="filter-bar-main">
        {onCap && cap != null ? (
          <>
            <CapMarketFilters cap={cap} onCap={onCap} inline />
            <span className="filter-sep" aria-hidden />
          </>
        ) : null}

        {onNote ? (
          <button
            type="button"
            className={`chip tag-chip tag-note ${note ? "on" : ""}`}
            onClick={() => onNote(!note)}
            title="Stocks with a saved research note"
          >
            Note
            <Count n={noteCount} />
          </button>
        ) : null}
        {onEdge ? (
          <button
            type="button"
            className={`chip tag-chip tag-edge ${edge ? "on" : ""}`}
            onClick={() => onEdge(!edge)}
            title="Early Edge watchlist"
          >
            Edge
            <Count n={edgeCount} />
          </button>
        ) : null}
        {onNiveshaay ? (
          <button
            type="button"
            className={`chip tag-chip tag-niveshaay ${niveshaay ? "on" : ""}`}
            onClick={() => onNiveshaay(!niveshaay)}
            title="Niveshaay fund watchlist"
          >
            Niveshaay
            <Count n={niveshaayCount} />
          </button>
        ) : null}
        {onNegen ? (
          <button
            type="button"
            className={`chip tag-chip tag-negen ${negen ? "on" : ""}`}
            onClick={() => onNegen(!negen)}
            title="Negen fund watchlist"
          >
            Negen
            <Count n={negenCount} />
          </button>
        ) : null}
        {onKacholia ? (
          <button
            type="button"
            className={`chip tag-chip tag-kacholia ${kacholia ? "on" : ""}`}
            onClick={() => onKacholia(!kacholia)}
            title="Kacholia fund watchlist"
          >
            Kacholia
            <Count n={kacholiaCount} />
          </button>
        ) : null}
        {onSme ? (
          <button
            type="button"
            className={`chip tag-chip tag-mkt-sme ${sme ? "on" : ""}`}
            onClick={() => onSme(!sme)}
            title="SME listings (NSE SME + BSE SME)"
          >
            SME
            <Count n={smeCount} />
          </button>
        ) : null}
        {onHold ? (
          <button
            type="button"
            className={`chip tag-chip tag-hold ${hold ? "on" : ""}`}
            onClick={() => onHold(!hold)}
            title={holdTitle}
          >
            Hold
            <Count n={holdCount} />
          </button>
        ) : null}

        {filtersActive ? (
          <button
            type="button"
            className="clear-filter"
            onClick={clearFilters}
            title="Reset cap and tag filters"
          >
            Clear
          </button>
        ) : null}

        {(onNote || onEdge || onNiveshaay || onNegen || onKacholia || onSme || onHold) &&
        onSignal ? (
          <span className="filter-sep" aria-hidden />
        ) : null}

        {onSignal ? (
          <>
            <button
              type="button"
              className={`chip signal-chip ${signal === "all" ? "on" : ""}`}
              onClick={() => onSignal("all")}
              title="All stocks in list"
            >
              All
            </button>
            <button
              type="button"
              className={`chip signal-chip tag-scan-tq ${signal === "tq" ? "on" : ""}`}
              onClick={() => onSignal("tq")}
              title="Weekly TQ only"
            >
              TQ
              <Count n={tqCount} />
            </button>
            <button
              type="button"
              className={`chip signal-chip tag-scan-bb ${signal === "bb" ? "on" : ""}`}
              onClick={() => onSignal("bb")}
              title="Weekly BB NEW only"
            >
              BB
              <Count n={bbCount} />
            </button>
            <button
              type="button"
              className={`chip signal-chip ${signal === "either" ? "on" : ""}`}
              onClick={() => onSignal("either")}
              title="TQ or BB (union)"
            >
              TQ | BB
            </button>
            <button
              type="button"
              className={`chip signal-chip ${signal === "both" ? "on" : ""}`}
              onClick={() => onSignal("both")}
              title="TQ and BB (intersection)"
            >
              TQ + BB
            </button>
            <span className="filter-sep" aria-hidden />
          </>
        ) : null}

        {!onSignal ? (
          <>
            <button
              type="button"
              className={`chip tag-chip tag-scan-bb ${bb ? "on" : ""}`}
              onClick={() => onBb(!bb)}
              title={
                bbDate
                  ? `Weekly BB NEW · week of Fri ${bbDate}`
                  : "Weekly BB NEW (Fri stamp)"
              }
            >
              BB
              <Count n={bbCount} />
              {bbDate ? (
                <span className="chip-date">{bbDate.slice(5)}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`chip tag-chip tag-scan-tq ${tq ? "on" : ""}`}
              onClick={() => onTq(!tq)}
              title={
                tqDate
                  ? `Weekly TQ · week of Fri ${tqDate}`
                  : "Weekly TQ (Fri stamp)"
              }
            >
              TQ
              <Count n={tqCount} />
              {tqDate ? (
                <span className="chip-date">{tqDate.slice(5)}</span>
              ) : null}
            </button>
            {onEma ? (
              <button
                type="button"
                className={`chip tag-chip tag-scan-ema ${ema ? "on" : ""}`}
                onClick={() => onEma(!ema)}
                title={
                  emaDate
                    ? `Daily EMA · close above 10/20/50/200 · ${emaDate}`
                    : "Daily EMA — price above 10/20/50/200"
                }
              >
                EMA
                <Count n={emaCount} />
                {emaDate ? (
                  <span className="chip-date">{emaDate.slice(5)}</span>
                ) : null}
              </button>
            ) : null}
          </>
        ) : null}

        <button
          type="button"
          className="chip chip-scan"
          disabled={busy}
          onClick={() => void runScan()}
          title="Refresh weekly BB/TQ and daily EMA signals"
        >
          {busy ? "…" : "Scan"}
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
              style={{ width: `${progress?.pct ?? 0}%` }}
            />
          </div>
          <span className="filter-progress-text">
            <strong>{progress?.label ?? "…"}</strong>
            {progress?.detail ? ` · ${progress.detail}` : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
