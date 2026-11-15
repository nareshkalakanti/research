"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loading } from "@/components/Loading";
import { napkinUrl, tradingviewUrl } from "@/lib/links";
import type { NanoFillJob, NanoPage, NanoStock } from "@/lib/nanocap-champs";

type Row = NanoStock & { sold_at?: string };

function num(v: number | null, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-IN", { maximumFractionDigits: digits });
}

function growth(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v > 999) return ">+999%";
  return `${v > 0 ? "+" : ""}${Math.round(v)}%`;
}

function quarterLabel(d: string | null): string {
  if (!d) return "";
  const dt = new Date(`${d}T00:00:00Z`);
  return Number.isFinite(dt.getTime())
    ? dt.toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" })
    : d;
}

function StockTable({
  rows,
  showSold,
  showGroup,
}: {
  rows: Row[];
  showSold?: boolean;
  showGroup?: boolean;
}) {
  return (
    <div className="table-wrap nano-wrap">
      <table className="data-table nano-table">
        <thead>
          <tr>
            <th className="nano-col-name">Stock</th>
            {showGroup ? <th>Group</th> : null}
            <th className="num">Value ₹ Cr</th>
            <th className="num">P/E</th>
            <th className="num">ROCE</th>
            <th className="num">Sales YoY</th>
            <th className="num">Profit YoY</th>
            <th className="num" title="Independent directors / board size">
              Indep / board
            </th>
            <th className="num" title="Other listed companies this board's directors also sit on">
              Other boards
            </th>
            <th className="num">12m</th>
            {showSold ? <th>Sold at</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ticker}>
              <td className="nano-col-name">
                <a
                  className="nano-name"
                  href={tradingviewUrl(r.ticker, r.market)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.name}
                </a>
                <span className="nano-meta">
                  {r.ticker}
                  <a className="np-chip" href={napkinUrl(r.ticker)} title="Open in Napkin">
                    NP
                  </a>
                </span>
              </td>
              {showGroup ? <td className="nano-group">{r.group ?? "—"}</td> : null}
              <td className="num">{num(r.mcap_cr)}</td>
              <td className="num">{num(r.pe, 1)}</td>
              <td className="num">{r.roce == null ? "—" : `${Math.round(r.roce * 100)}%`}</td>
              <td className="num">{growth(r.sales_yoy)}</td>
              <td className="num" title={r.latest_quarter ? `Quarter to ${quarterLabel(r.latest_quarter)}` : ""}>
                {growth(r.profit_yoy)}
              </td>
              <td className="num">{r.board ? `${r.independent} / ${r.board}` : "—"}</td>
              <td className="num">{r.board ? r.linked_boards : "—"}</td>
              <td className="num">{growth(r.momentum_12m)}</td>
              {showSold ? <td>{r.sold_at}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Nanocap Champs: current basket, past picks, how it changed, and look-alikes. */
export function NanocapPanel() {
  const [data, setData] = useState<NanoPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<NanoFillJob | null>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nanocap", { cache: "no-store" });
      const json = (await res.json()) as NanoPage & {
        ok: boolean;
        error?: string;
        job?: NanoFillJob | null;
      };
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
      setJob(json.job ?? null);
      wasRunning.current = !!json.job?.running;
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll progress while a fetch runs; reload the lists when it finishes.
  const running = !!job?.running;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(async () => {
      try {
        const res = await fetch("/api/nanocap?job=1", { cache: "no-store" });
        const json = (await res.json()) as { job?: NanoFillJob | null };
        const next = json.job ?? null;
        setJob(next);
        if (wasRunning.current && !next?.running) {
          wasRunning.current = false;
          void load();
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [running, load]);

  const fill = async (kind: "nano" | "quality") => {
    try {
      const res = await fetch("/api/nanocap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const json = (await res.json()) as { job?: NanoFillJob };
      if (json.job) {
        setJob(json.job);
        wasRunning.current = json.job.running;
      }
    } catch (e) {
      setJob({
        kind,
        running: false,
        done: 0,
        total: 0,
        filled: 0,
        left: null,
        error: e instanceof Error ? e.message : String(e),
        started_at: "",
        finished_at: null,
      });
    }
  };

  const fillLabel = (kind: "nano" | "quality", idle: string) =>
    job?.running && job.kind === kind ? (
      <>
        <span className="ld-spin" aria-hidden /> Fetching…
      </>
    ) : (
      idle
    );

  /** Scan-style progress bar: live while running, result once done. */
  const fillNote = (kind: "nano" | "quality") => {
    if (!job || job.kind !== kind) return null;
    const total = job.total || 25;
    const pct = job.running ? Math.max(4, Math.round((job.done / total) * 100)) : 100;
    const what = kind === "quality" ? "ROCE" : "quarterly results";
    return (
      <div
        className={`filter-progress nano-progress ${job.error ? "is-error" : ""} ${
          !job.running && !job.error ? "is-done" : ""
        }`}
        role="status"
        aria-live="polite"
      >
        <div className="filter-progress-track">
          <div className="filter-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="filter-progress-text">
          {job.running ? (
            <>
              <strong>Fetching {what}</strong> · {job.done} of {total} · runs in the background, safe to
              switch tabs
            </>
          ) : job.error ? (
            <strong>{job.error}</strong>
          ) : (
            <>
              <strong>Done</strong> · got {what} for {job.filled} of {job.done}
              {job.left != null ? ` · ${job.left} still missing` : ""}
            </>
          )}
        </span>
      </div>
    );
  };

  if (error && !data) {
    return (
      <div className="panel">
        <p className="miq-empty-hint">Could not load Nanocap Champs: {error}</p>
      </div>
    );
  }
  if (!data) return <Loading label="Loading Nanocap Champs" variant="block" />;

  const r = data.rules;
  const q = data.quality_rules;
  return (
    <div className="panel nano-panel">
      <div className="missing-head">
        <div>
          <h2>Nanocap Champs</h2>
          <p className="missing-sub">
            Small NSE companies with an independent, well-connected board — bought cheap when profit turns up.
          </p>
        </div>
      </div>

      <section className="nano-section">
        <h3>
          Current holdings <span className="nano-count">{data.current.length}</span>
        </h3>
        <StockTable rows={data.current} />
      </section>

      <section className="nano-section">
        <h3>How the basket changed</h3>
        <ol className="nano-stages">
          {data.stages.map((s) => (
            <li key={s.label}>
              <span className="nano-stage-label">{s.label}</span>
              {s.in.length ? (
                <span>
                  <strong>Bought</strong> {s.in.join(", ")}
                </span>
              ) : null}
              {s.out.length ? (
                <span>
                  <strong>Sold</strong> {s.out.join(", ")}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="nano-note">Order read from the constituents sheet; it has no dates.</p>
      </section>

      <section className="nano-section">
        <h3>
          Past holdings <span className="nano-count">{data.past.length}</span>
        </h3>
        <StockTable rows={data.past} showSold />
      </section>

      <section className="nano-section">
        <h3>
          Fits the pattern now <span className="nano-count">{data.candidates.length}</span>
        </h3>
        <p className="nano-note">
          NSE main board · ₹{r.minMcapCr}–{r.maxMcapCr} Cr · P/E ≤ {r.maxPe} · sales and profit up vs
          same quarter last year · at least half the board independent · directors sit on{" "}
          {r.minLinkedBoards}+ other listed boards. Not in the basket now or before.
          <br />
          Size: their stated limit is ₹500 Cr, but recent buys go up to about ₹1,700 Cr (PTC India
          Financial, PNB Gilts), so the screen runs to ₹{r.maxMcapCr.toLocaleString("en-IN")} Cr.
        </p>
        {data.candidates.length ? (
          <StockTable rows={data.candidates} />
        ) : (
          <p className="miq-empty-hint">No stocks pass every rule right now.</p>
        )}
        <div className="nano-fill">
          <span>
            Checked {data.coverage.with_quarters} of {data.coverage.universe} stocks in the size band
            {data.coverage.missing ? ` · ${data.coverage.missing} have no quarterly results yet` : ""}
          </span>
          {data.coverage.missing ? (
            <button type="button" className="btn-fill" disabled={running} onClick={() => void fill("nano")}>
              {fillLabel("nano", "Fetch missing results (25)")}
            </button>
          ) : null}
          {fillNote("nano")}
        </div>
      </section>

      <section className="nano-section">
        <h3>
          Steady group companies (RPG Life type){" "}
          <span className="nano-count">{data.quality.length}</span>
        </h3>
        <p className="nano-note">
          The basket also holds larger, steady names with strong boards — RPG Life was about ₹3,600 Cr
          when bought. Rules: NSE main board · part of a business group · ₹
          {q.minMcapCr.toLocaleString("en-IN")}–{q.maxMcapCr.toLocaleString("en-IN")} Cr · ROCE ≥{" "}
          {Math.round(q.minRoce * 100)}% · at least two-thirds of the board independent · sales up vs
          same quarter last year · no P/E limit.
        </p>
        {data.quality.length ? (
          <StockTable rows={data.quality} showGroup />
        ) : (
          <p className="miq-empty-hint">No stocks pass every rule right now.</p>
        )}
        <div className="nano-fill">
          <span>
            ROCE known for {data.quality_coverage.with_roce} of {data.quality_coverage.universe} group
            stocks in the band
          </span>
          {data.quality_coverage.missing ? (
            <button type="button" className="btn-fill" disabled={running} onClick={() => void fill("quality")}>
              {fillLabel("quality", "Fetch missing ROCE (25)")}
            </button>
          ) : null}
          {fillNote("quality")}
        </div>
      </section>
    </div>
  );
}
