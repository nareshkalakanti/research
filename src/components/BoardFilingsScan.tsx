"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notifyGovMapChanged } from "@/lib/gov-map-sync";
import type { BoardroomJob } from "@/lib/boardroom-job";

const PHASE: Record<BoardroomJob["phase"], string> = {
  discover: "Finding board filings on NSE",
  analyse: "Reading filings",
  push: "Adding directors to Governance",
  done: "Done",
  stopped: "Stopped",
  error: "Failed",
};

/**
 * Governance page: scan NSE board / director filings and add new board seats,
 * with live progress. Replaces `npm run scan:boardroom-bg` + `push:boardroom-gov`.
 */
export function BoardFilingsScan() {
  const [job, setJob] = useState<BoardroomJob | null>(null);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [poll, setPoll] = useState(0);
  const wasRunning = useRef(false);

  // Status on load and every 2 s while running (a run keeps going if you leave the page).
  useEffect(() => {
    let live = true;
    void fetch("/api/boardroom-job", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { job?: BoardroomJob | null }) => {
        if (!live) return;
        const next = j.job ?? null;
        if (wasRunning.current && next && !next.running && (next.pushed_seats > 0 || next.with_din > 0)) notifyGovMapChanged();
        wasRunning.current = !!next?.running;
        setJob(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [poll]);
  useEffect(() => {
    if (!job?.running) return;
    const t = setTimeout(() => setPoll((n) => n + 1), 2000);
    return () => clearTimeout(t);
  }, [job, poll]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/boardroom-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days, limit: 60 }),
      });
      const j = (await r.json()) as { job?: BoardroomJob };
      if (j.job) {
        wasRunning.current = true;
        setJob(j.job);
      }
    } finally {
      setBusy(false);
    }
  }, [days]);

  const stop = useCallback(async () => {
    await fetch("/api/boardroom-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    setPoll((n) => n + 1);
  }, []);

  const running = !!job?.running;
  const pct =
    job && job.total ? Math.round((job.done / job.total) * 100) : job?.phase === "push" || job?.phase === "done" ? 100 : 0;

  return (
    <div className="bfs">
      <div className="bfs-head">
        <div>
          <strong>Board filings</strong>
          <span className="bfs-sub">
            Read NSE board-meeting and director-change filings, pull out directors (DIN) and add new board seats here.
          </span>
        </div>
        <div className="bfs-actions">
          <label className="bfs-days">
            Last
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={running} aria-label="Days to look back">
              {[2, 7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          {running ? (
            <button type="button" className="btn-ghost" onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button type="button" className="btn-fill" disabled={busy} onClick={() => void start()}>
              {busy ? "Starting…" : "Scan board filings"}
            </button>
          )}
        </div>
      </div>

      {job ? (
        <div className="bfs-run" role="status">
          <div className="bfs-line">
            <span className={`bfs-phase bfs-phase--${job.phase}`}>{PHASE[job.phase]}</span>
            <span>
              {job.phase === "discover"
                ? `last ${job.days} days…`
                : job.total
                  ? `${job.done} of ${job.total} filings read · ${job.with_din} with directors${
                      job.failed ? ` · ${job.failed} could not be read` : ""
                    }`
                  : job.found
                    ? `${job.found} filings found, all read before`
                    : ""}
              {job.phase === "done" || job.phase === "push"
                ? ` · ${job.pushed_seats} board seats synced to Governance from ${job.pushed_rows} filings`
                : ""}
            </span>
            {!running && job.finished_at ? (
              <span className="bfs-when">{new Date(job.finished_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
            ) : null}
          </div>
          {running || job.phase === "done" ? (
            <div className={`bfs-bar${running ? " bfs-bar--run" : ""}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          {job.note ? <p className="bfs-note">{job.note}</p> : null}
          {job.error ? <p className="bfs-note bfs-note--err">{job.error}</p> : null}
          {running && job.current.length ? (
            <ul className="bfs-current">
              {job.current.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
          {/* Live list while scanning only; once done the summary line is enough. */}
          {running && job.joins.length ? (
            <div className="bfs-joins">
              <span className="bfs-joins-label">Directors found this run</span>
              <ul>
                {job.joins.slice(0, 8).map((j, i) => (
                  <li key={`${i}-${j.ticker}-${j.at}`}>
                    <b>{j.ticker}</b> {j.names}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
