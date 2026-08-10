"use client";

import { useCallback, useState } from "react";
import { FillForwardPeButton } from "@/components/FillForwardPeButton";

type Props = {
  bb: boolean;
  tq: boolean;
  onBb: (on: boolean) => void;
  onTq: (on: boolean) => void;
  hold?: boolean;
  onHold?: (on: boolean) => void;
  edge?: boolean;
  onEdge?: (on: boolean) => void;
  note?: boolean;
  onNote?: (on: boolean) => void;
  bbCount?: number;
  tqCount?: number;
  holdCount?: number;
  edgeCount?: number;
  noteCount?: number;
  bbDate?: string | null;
  tqDate?: string | null;
  market: string;
  onDone?: () => void | Promise<void>;
  fpeTickers?: string[];
  fpePending?: number;
  onFpeDone?: () => void | Promise<void>;
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
  const json = (await res.json()) as {
    ok?: boolean;
    tried?: number;
    bbHits?: number;
    tqHits?: number;
    remaining?: number;
    session?: { bb: string | null; tq: string | null };
    error?: string;
  };
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `Scan failed (${res.status})`);
  }
  return json;
}

/** Filters + Scan: weekly BB/TQ (incremental). Fwd PE fills separately. */
export function ScanFilters({
  bb,
  tq,
  onBb,
  onTq,
  hold = false,
  onHold,
  edge = false,
  onEdge,
  note = false,
  onNote,
  bbCount,
  tqCount,
  holdCount,
  edgeCount,
  noteCount,
  bbDate,
  tqDate,
  market,
  onDone,
  fpeTickers,
  fpePending,
  onFpeDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  const runScan = useCallback(async () => {
    setBusy(true);
    setProgress({
      pct: 3,
      label: "Scanning",
      detail: "BB/TQ…",
    });

    let remaining = 1;
    let gotBb = 0;
    let gotTq = 0;
    let sessionLabel = "";

    try {
      for (let round = 1; round <= 120; round += 1) {
        const json = await scanOnce({
          kind: "both",
          market,
          limit: 40,
          missingOnly: true,
        });
        gotBb += json.bbHits ?? 0;
        gotTq += json.tqHits ?? 0;
        remaining = json.remaining ?? 0;
        if (json.session?.bb || json.session?.tq) {
          sessionLabel = json.session.bb || json.session.tq || "";
        }
        setProgress({
          pct: remaining <= 0 ? 100 : Math.min(98, 3 + round * 1.5),
          label: remaining <= 0 ? "Done" : "Scanning",
          detail: `BB/TQ ${gotBb}/${gotTq} · ${remaining.toLocaleString()} left${
            sessionLabel ? ` · ${sessionLabel}` : ""
          }`,
          done: remaining <= 0,
        });
        await onDone?.();
        if (json.tried === 0 || remaining <= 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      onBb(true);
      onTq(true);
      setProgress({
        pct: 100,
        label: "Done",
        detail: `${gotBb} BB · ${gotTq} TQ${
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
  }, [market, onDone, onBb, onTq]);

  return (
    <div className="breakout-bar">
      <div className="breakout-filters">
        {onNote ? (
          <button
            type="button"
            className={`breakout-chip note ${note ? "on" : ""}`}
            onClick={() => onNote(!note)}
            title="Stocks with a saved research note"
          >
            NOTE
            {noteCount != null ? <em>{noteCount}</em> : null}
          </button>
        ) : null}
        {onEdge ? (
          <button
            type="button"
            className={`breakout-chip edge ${edge ? "on" : ""}`}
            onClick={() => onEdge(!edge)}
            title="Early Edge + Negen + Niveshaay"
          >
            EDGE
            {edgeCount != null ? <em>{edgeCount}</em> : null}
          </button>
        ) : null}
        {onHold ? (
          <button
            type="button"
            className={`breakout-chip hold ${hold ? "on" : ""}`}
            onClick={() => onHold(!hold)}
          >
            HOLD
            {holdCount != null ? <em>{holdCount}</em> : null}
          </button>
        ) : null}
        <button
          type="button"
          className={`breakout-chip bb ${bb ? "on" : ""}`}
          onClick={() => onBb(!bb)}
          title={
            bbDate
              ? `Weekly BB NEW · week of Fri ${bbDate}`
              : "Weekly BB NEW (Fri stamp)"
          }
        >
          BB
          {bbCount != null ? <em>{bbCount}</em> : null}
          {bbDate ? (
            <span className="breakout-date">{bbDate.slice(5)}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={`breakout-chip tq ${tq ? "on" : ""}`}
          onClick={() => onTq(!tq)}
          title={
            tqDate
              ? `Weekly TQ · week of Fri ${tqDate}`
              : "Weekly TQ (Fri stamp)"
          }
        >
          TQ
          {tqCount != null ? <em>{tqCount}</em> : null}
          {tqDate ? (
            <span className="breakout-date">{tqDate.slice(5)}</span>
          ) : null}
        </button>
      </div>
      <div className="breakout-actions">
        {onFpeDone ? (
          <FillForwardPeButton
            market={market}
            tickers={fpeTickers}
            pendingCount={fpePending}
            onDone={onFpeDone}
          />
        ) : null}
        <button
          type="button"
          className="breakout-scan"
          disabled={busy}
          onClick={() => void runScan()}
        >
          {busy ? "Scanning…" : "Scan"}
        </button>
      </div>
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
