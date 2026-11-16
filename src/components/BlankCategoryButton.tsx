"use client";

import { useCallback, useEffect, useState } from "react";
import type { BlankFixJob, BlankFixStatus } from "@/lib/governance-blank-fix";

function Progress({ job, what }: { job: BlankFixJob; what: string }) {
  const pct = job.running ? Math.max(3, Math.round((job.done / Math.max(1, job.total)) * 100)) : 100;
  return (
    <div
      className={`filter-progress status-block ${job.error ? "is-error" : ""} ${!job.running && !job.error ? "is-done" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="filter-progress-track">
        <div className="filter-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="filter-progress-text">
        {job.running ? (
          <>
            <strong>{what}</strong> · {job.done} of {job.total}
            {job.current ? ` · ${job.current}` : ""} · runs in the background, safe to switch tabs
          </>
        ) : job.error ? (
          <strong>{job.error}</strong>
        ) : (
          <>
            <strong>{job.stopping ? "Stopped" : "Done"}</strong> · roles filled for {job.saved} of {job.done} companies
            {job.empty ? ` · ${job.empty} with nothing found` : ""}
            {job.failed ? ` · ${job.failed} failed` : ""}
          </>
        )}
      </span>
    </div>
  );
}

/** Data tab: fill missing director roles (independent / executive) — NSE filings, then annual reports. */
export function BlankCategoryButton() {
  const [st, setSt] = useState<BlankFixStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const j = (await (await fetch("/api/governance-blank-fix", { cache: "no-store" })).json()) as BlankFixStatus;
      setSt(j);
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = !!st?.job?.running || !!st?.ar_job?.running;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(id);
  }, [running, load]);

  const post = async (body: Record<string, unknown>) => {
    try {
      const j = (await (
        await fetch("/api/governance-blank-fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()) as BlankFixStatus;
      setSt(j);
    } catch {
      /* ignore */
    }
  };

  const nseRunning = !!st?.job?.running;
  const arRunning = !!st?.ar_job?.running;

  return (
    <div className={`fill-panel ${running ? "is-busy" : ""}`}>
      <div className="fill-actions">
        <span className="status-line">
          {st ? (
            <>
              <strong>{st.blank_total}</strong> companies have directors with unknown roles (independent / executive)
            </>
          ) : (
            "Loading…"
          )}
        </span>
      </div>
      <div className="fill-actions">
        <button
          type="button"
          className="btn-fill"
          disabled={running || !st?.blank_nse}
          onClick={() => void post({})}
          title="NSE corporate-governance filings (main board)"
        >
          {nseRunning ? (
            <>
              <span className="ld-spin" aria-hidden /> Fetching boards…
            </>
          ) : (
            `From NSE filings (${st?.blank_nse ?? 0})`
          )}
        </button>
        <button
          type="button"
          className="btn-fill"
          disabled={running || !st?.ar_to_try}
          onClick={() => void post({ mode: "ar" })}
          title="Read each company's latest annual report on NSE and match directors to their roles"
        >
          {arRunning ? (
            <>
              <span className="ld-spin" aria-hidden /> Reading reports…
            </>
          ) : (
            `From annual reports (${st?.ar_to_try ?? 0})`
          )}
        </button>
        {running ? (
          <button
            type="button"
            className="btn-fill-all"
            onClick={() => void post(arRunning ? { mode: "ar", stop: true } : { stop: true })}
          >
            Stop
          </button>
        ) : null}
      </div>
      {st ? (
        <p className="status-note">
          SME companies don&apos;t file NSE governance reports, so their roles come from annual reports.
          {st.blank_other || st.blank_no_filing
            ? ` Still unknown after both: BSE-only companies and reports that don't list roles.`
            : ""}
          {st.blank_unlisted ? ` ${st.blank_unlisted} delisted or renamed companies are not counted.` : ""}
        </p>
      ) : null}
      {st?.job ? <Progress job={st.job} what="Fetching NSE boards" /> : null}
      {st?.ar_job ? <Progress job={st.ar_job} what="Reading annual reports" /> : null}
    </div>
  );
}
