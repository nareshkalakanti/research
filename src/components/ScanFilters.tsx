"use client";

import { useCallback, useState } from "react";
import {
  CapMarketFilters,
  type CapFilter,
} from "@/components/CapMarketFilters";

type Props = {
  cap?: CapFilter;
  onCap?: (cap: CapFilter) => void;
  bb: boolean;
  tq: boolean;
  onBb: (on: boolean) => void;
  onTq: (on: boolean) => void;
  hold?: boolean;
  onHold?: (on: boolean) => void;
  distressCount?: number;
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
    remaining?: number;
    session?: { bb: string | null; tq: string | null };
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
  distressCount,
  edgeCount,
  noteCount,
  bbDate,
  tqDate,
  market,
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  const runScan = useCallback(async () => {
    setBusy(true);
    setProgress({ pct: 2, label: "Scanning", detail: "Starting BB/TQ…" });

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
          const iso = json.session.bb || json.session.tq || "";
          sessionLabel = iso ? weekStamp(iso) : "";
        }
        const pct =
          remaining <= 0 ? 100 : Math.min(97, 3 + round * 2);
        setProgress({
          pct,
          label: remaining <= 0 ? "Done" : "Scanning BB/TQ",
          detail: `${gotBb} BB · ${gotTq} TQ · ${remaining.toLocaleString()} left${
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

  const holdTitle =
    distressCount && distressCount > 0
      ? `Holdings (${holdCount ?? 0}) · ${distressCount} distress monitors`
      : "Your holdings";

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

        {(onNote || onEdge || onHold) && (onBb || onTq) ? (
          <span className="filter-sep" aria-hidden />
        ) : null}

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
          {bbDate ? <span className="chip-date">{bbDate.slice(5)}</span> : null}
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
          {tqDate ? <span className="chip-date">{tqDate.slice(5)}</span> : null}
        </button>

        <button
          type="button"
          className="chip chip-scan"
          disabled={busy}
          onClick={() => void runScan()}
          title="Refresh weekly BB/TQ stamps"
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
