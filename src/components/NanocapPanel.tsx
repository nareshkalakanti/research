"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FilterBar, PageHead, Pick, Seg, Toggle } from "@/components/FilterBar";
import { Loading } from "@/components/Loading";
import { napkinUrl, tradingviewUrl, websiteUrl } from "@/lib/links";
import type { NanoFillJob } from "@/lib/nanocap-champs";
import type { MomPage, MomStock } from "@/lib/momentum";

type Kind = NanoFillJob["kind"];

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

const CHECK_LABEL: Record<MomStock["checks"][number]["id"], string> = {
  sustained: "Sustained",
  organic: "Organic",
  clean: "Clean profit",
  value: "Value",
  board: "Board",
};

/** Fast run: ~7.5 s a stock. */
function fmtFastTime(n: number): string {
  const min = Math.round((n * 7.5) / 60);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = min / 60;
  return `${h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h)} h`;
}

function fmtLeftTime(hours: number): string {
  if (hours < 1) return "under an hour";
  if (hours < 36) return `about ${Math.round(hours)} h of app time`;
  return `about ${Math.round(hours / 24)} days of app time`;
}

/** ROCE / ROE fill: always-visible progress (filled · left · next batch), live while a batch runs. */
function RatioFill({
  cov,
  perHour,
  job,
  disabled,
  onFast,
  onStop,
}: {
  cov: MomPage["coverage"];
  perHour: number;
  job: NanoFillJob | null;
  disabled: boolean;
  onFast: () => void;
  onStop: () => void;
}) {
  // Tick so "next batch in ~N min" counts down without reloading the page.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const live = job?.running && (job.kind === "momratio" || job.kind === "auto") ? job : null;
  const liveDone = live?.kind === "momratio" ? live.done : 0;
  const noData = cov.no_ratios - cov.ratio_to_try;
  const left = Math.max(0, cov.ratio_to_try - liveDone);
  // Everything that started without ROCE / ROE: done (got it or nothing on Screener) + still to try.
  const checked = cov.ratio_filled + noData + liveDone;
  const total = checked + left;
  const pct = total ? Math.max(1, Math.round((checked / total) * 100)) : 100;
  const nextMin = cov.next_auto_at ? Math.round((Date.parse(cov.next_auto_at) - now) / 60_000) : null;
  const doneAll = left === 0;
  const pace = cov.ratio_pace || Math.max(1, perHour - 30);
  return (
    <div
      className={`filter-progress status-block nano-progress mom-ratio ${doneAll ? "is-done" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="mom-ratio-head">
        <strong>ROCE / ROE fill</strong>
        <span className="mom-ratio-nums">
          <b>{checked.toLocaleString("en-IN")}</b> of {total.toLocaleString("en-IN")} checked ·{" "}
          <b>{left.toLocaleString("en-IN")}</b> left · {pct}%
        </span>
        {live?.kind === "momratio" ? (
          <button type="button" className="btn-fill-all" onClick={onStop}>
            Stop
          </button>
        ) : !doneAll && cov.ratio_to_try && !cov.paused_until ? (
          <button
            type="button"
            className="btn-fill"
            disabled={disabled}
            onClick={onFast}
            title="One Screener page every 6–9 s until done; stops by itself if Screener pushes back"
          >
            Fill all now (~{fmtFastTime(left)})
          </button>
        ) : null}
      </div>
      <div className="filter-progress-track">
        <div className="filter-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="filter-progress-text">
        {doneAll ? (
          "Every stock with recent results has ROCE / ROE — all can be scored."
        ) : live ? (
          <>
            <span className="ld-spin" aria-hidden />{" "}
            {live.kind === "momratio" ? "Fetching ROCE / ROE" : "Background batch running"} · {live.done} of{" "}
            {live.total || "…"}
            {live.kind === "momratio" && live.total > 60
              ? ` · ~${fmtFastTime(live.total - live.done)} left · runs on the server, safe to close the tab`
              : " · the list updates when it finishes"}
          </>
        ) : cov.paused_until ? (
          `Screener asked us to slow down — paused until ${new Date(cov.paused_until).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}, then it carries on.`
        ) : (
          <>
            {cov.ratio_filled} got ROCE / ROE → <b>{cov.ratio_scored}</b> can now be scored (the rest are mostly
            loss-making, so profit growth can&apos;t be measured)
            {noData ? ` · ${noData} had nothing on Screener` : ""} · recent pace ~{pace} an hour, fastest growers first
            {nextMin != null ? (nextMin > 0 ? ` · next batch in ~${nextMin} min` : " · next batch starting soon") : ""} ·{" "}
            {fmtLeftTime(left / pace)} left
          </>
        )}
      </span>
    </div>
  );
}

/** One list: 7-Rule Strong Buy + Buy with Strong quarters; filter chips for rating and clean checks. */
type CapBand = "all" | "micro" | "small" | "mid" | "large";

/** Market-cap bands (₹ Cr) for the filter chips. */
const CAP_BANDS: ReadonlyArray<readonly [CapBand, string, number, number]> = [
  ["all", "All caps", 0, Infinity],
  ["micro", "Under ₹500 Cr", 0, 500],
  ["small", "₹500–2,000 Cr", 500, 2000],
  ["mid", "₹2,000–10,000 Cr", 2000, 10000],
  ["large", "₹10,000 Cr+", 10000, Infinity],
];

function inBand(mcap: number | null | undefined, band: CapBand): boolean {
  if (band === "all") return true;
  const b = CAP_BANDS.find((x) => x[0] === band)!;
  return mcap != null && mcap >= b[2] && mcap < b[3];
}

function MomList({ strong, near }: { strong: MomStock[]; near: MomStock[] }) {
  const [show, setShow] = useState<"all" | "sb" | "buy">("all");
  const [cleanOnly, setCleanOnly] = useState(false);
  const [mkt, setMkt] = useState<"all" | "nse" | "bse" | "bsesme">("all");
  const mktOf = (m: string | null | undefined) =>
    m === "BSE" ? "bse" : m === "BSE SME" ? "bsesme" : "nse";
  const all = [...strong, ...near].sort(
    (a, b) => b.passed - a.passed || b.quarter_score - a.quarter_score || (b.mcap_cr ?? 0) - (a.mcap_cr ?? 0),
  );
  const [cap, setCap] = useState<CapBand>("all");
  const inMkt = all.filter((r) => mkt === "all" || mktOf(r.market) === mkt);
  const inCap = inMkt.filter((r) => inBand(r.mcap_cr, cap));
  const rows = inCap.filter(
    (r) =>
      (show === "all" || (show === "sb" ? r.passed >= 7 : r.passed === 6)) &&
      (!cleanOnly || r.checks.every((c) => c.ok !== false)),
  );
  return (
    <section className="nano-section">
      <FilterBar>
        <Seg
          label="Rating"
          value={show}
          onChange={setShow}
          options={[
            { id: "all", label: "All", count: inCap.length },
            { id: "sb", label: "Strong Buy", count: inCap.filter((r) => r.passed >= 7).length },
            { id: "buy", label: "Buy", count: inCap.filter((r) => r.passed === 6).length },
          ]}
        />
        <Pick
          label="Size"
          value={cap}
          onChange={setCap}
          options={CAP_BANDS.map(([id, label]) => ({ id, label, count: inMkt.filter((r) => inBand(r.mcap_cr, id)).length }))}
        />
        <Pick
          label="Exchange"
          value={mkt}
          onChange={setMkt}
          options={(
            [
              ["all", "All"],
              ["nse", "NSE + NSE SME"],
              ["bse", "BSE"],
              ["bsesme", "BSE SME"],
            ] as const
          ).map(([id, label]) => ({ id, label, count: id === "all" ? all.length : all.filter((r) => mktOf(r.market) === id).length }))}
        />
        <Toggle label="Hide failed checks" checked={cleanOnly} onChange={setCleanOnly} title="Hide stocks with any ✗ check" />
      </FilterBar>
      {rows.length ? <MomTable rows={rows} /> : <p className="miq-empty-hint">None right now.</p>}
    </section>
  );
}

/** Momentum: 7/7 rules + Quarters score, with the five sanity checks as chips. */
function MomTable({ rows }: { rows: MomStock[] }) {
  return (
    <div className="table-wrap nano-wrap">
      <table className="data-table nano-table mom-table">
        <thead>
          <tr>
            <th className="nano-col-name">Stock</th>
            <th>7-Rule</th>
            <th className="num" title="Quarters growth score out of 10">
              Quarters
            </th>
            <th className="num">Value ₹ Cr</th>
            <th className="num">P/E</th>
            <th className="num">ROCE</th>
            <th className="num">Sales YoY</th>
            <th className="num">Profit YoY</th>
            <th className="num">Sales QoQ</th>
            <th className="num">Profit QoQ</th>
            <th title="Hover a chip for the reason">Checks</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ticker}>
              <td className="nano-col-name">
                <a className="nano-name" href={tradingviewUrl(r.ticker, r.market)} target="_blank" rel="noreferrer">
                  {r.name}
                </a>
                <span className="nano-meta">
                  {r.ticker}
                  {r.market && r.market !== "NSE" ? (
                    <span title={r.market === "BSE" ? "BSE main board — not listed on NSE" : undefined}>
                      · {r.market}
                    </span>
                  ) : null}
                  {r.latest_quarter ? <span>· {quarterLabel(r.latest_quarter)}</span> : null}
                  <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                    NP
                  </a>
                  {websiteUrl(r.website) ? (
                    <a
                      className="np-chip"
                      href={websiteUrl(r.website)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={r.website ?? ""}
                    >
                      Web
                    </a>
                  ) : null}
                </span>
                {r.sector ? (
                  <span className="mom-sector">
                    {r.sector}
                    {r.sub_sector ? ` › ${r.sub_sector}` : ""}
                  </span>
                ) : null}
              </td>
              <td>
                <span className={`seven-rule-rating ${r.passed >= 7 ? "seven-rule-rating--buy mom-sb" : "seven-rule-rating--buy"}`}>
                  {r.passed >= 7 ? "Strong Buy" : "Buy"} · {r.passed}/7
                </span>
              </td>
              <td className="num">
                <span className="mom-q">{r.quarter_score.toFixed(1)}</span>
              </td>
              <td className="num">{num(r.mcap_cr)}</td>
              <td className="num">{num(r.pe, 1)}</td>
              <td className="num">{r.roce == null ? "—" : `${Math.round(r.roce * 100)}%`}</td>
              <td className="num">{growth(r.sales_yoy)}</td>
              <td className="num">{growth(r.np_yoy)}</td>
              <td className="num">{growth(r.sales_qoq)}</td>
              <td className="num">{growth(r.np_qoq)}</td>
              <td>
                <span className="mom-checks">
                  {r.checks.map((c) =>
                    c.id === "board" && c.ok == null && r.zauba_url ? (
                      <a
                        key={c.id}
                        className="mom-ck unk mom-ck-link"
                        href={r.zauba_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Board not known — check directors on Zaubacorp"
                      >
                        ? {CHECK_LABEL[c.id]} ↗
                      </a>
                    ) : (
                      <span
                        key={c.id}
                        className={`mom-ck ${c.ok === true ? "ok" : c.ok === false ? "bad" : "unk"}`}
                        title={c.note}
                      >
                        {c.ok === true ? "✓" : c.ok === false ? "✗" : "?"} {CHECK_LABEL[c.id]}
                      </span>
                    ),
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Quality Growth tab: high-return companies with fast, clean earnings growth. */
export function NanocapPanel() {
  const [data, setData] = useState<MomPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<NanoFillJob | null>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nanocap?basket=mom", { cache: "no-store" });
      const json = (await res.json()) as MomPage & {
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
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  // Poll progress while a fetch runs; reload the lists when it finishes.
  const running = !!job?.running;
  // Poll fast while a job runs; slowly otherwise, to notice the background refresh starting.
  useEffect(() => {
    const id = window.setInterval(async () => {
      try {
        const res = await fetch("/api/nanocap?job=1", { cache: "no-store" });
        const json = (await res.json()) as { job?: NanoFillJob | null };
        const next = json.job ?? null;
        setJob(next);
        if (next?.running) wasRunning.current = true;
        if (wasRunning.current && !next?.running) {
          wasRunning.current = false;
          void load();
        }
      } catch {
        /* keep polling */
      }
    }, running ? 3000 : 60_000);
    return () => window.clearInterval(id);
  }, [running, load]);

  const fill = async (kind: Kind, all = false, extra?: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/nanocap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, all, ...extra }),
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
        not_found: null,
        error: e instanceof Error ? e.message : String(e),
        started_at: "",
        finished_at: null,
      });
    }
  };

  const fillLabel = (kind: Kind, idle: string) =>
    job?.running && job.kind === kind ? (
      <>
        <span className="ld-spin" aria-hidden /> Fetching…
      </>
    ) : (
      idle
    );

  /** Scan-style progress bar: live while running, result once done. */
  const fillNote = (kind: Kind) => {
    if (!job || job.kind !== kind) return null;
    const total = job.total || 25;
    const pct = job.running ? Math.max(4, Math.round((job.done / total) * 100)) : 100;
    const what =
      kind === "momratio"
        ? "ROCE and ROE"
        : kind === "bse"
          ? "results and ROCE / ROE for BSE-only stocks"
          : "quarterly results";
    return (
      <div
        className={`filter-progress status-block nano-progress ${job.error ? "is-error" : ""} ${
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
              <strong>Fetching {what}</strong> · {job.done} of {total}
              {total > 25 ? ` · about ${Math.max(1, Math.round(((total - job.done) * 8) / 60))} min left` : ""} · runs in the
              background, safe to switch tabs
            </>
          ) : job.error ? (
            <strong>{job.error}</strong>
          ) : (
            <>
              <strong>Done</strong> · got {what} for {job.filled} of {job.done}
              {job.left != null ? ` · ${job.left} left to try` : ""}
              {job.not_found ? ` · ${job.not_found} not on Screener (retried after a week)` : ""}
            </>
          )}
        </span>
      </div>
    );
  };

  if (error && !data) {
    return (
      <div className="panel nano-panel">
        <p className="miq-empty-hint">Could not load: {error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="panel nano-panel">
        <Loading
          label="Scoring quarters for Quality Growth"
          variant="block"
        />
      </div>
    );
  }

  const autoNote =
    job?.kind === "auto" ? (
      <p className="nano-auto" role="status" aria-live="polite">
        {job.running ? (
          <>
            <span className="ld-spin" aria-hidden /> Background refresh · {job.done} of {job.total || "…"} · checking new
            results and ROCE / ROE
          </>
        ) : job.finished_at ? (
          <>
            Last background refresh{" "}
            {new Date(job.finished_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · runs every 30
            min while the app is open
          </>
        ) : null}
      </p>
    ) : null;

  const mr = data.rules;
  const cov = data.coverage;
  return (
    <div className="panel nano-panel">
      {autoNote}
      <PageHead
        title="Quality Growth"
        sub="High-return companies (ROCE and ROE over 15%) with fast, clean earnings growth."
      >
        <p>
          7-Rule <strong>Strong Buy</strong> (7/7) or <strong>Buy</strong> (6/7) — ROCE and ROE over 15%, sales and
          profit up on last quarter and last year, margin up — <em>and</em> a Strong quarterly growth score (
          {mr.minQuarterScore}+/10).
        </p>
        <p>
          Checks (hover a chip for the reason): <strong>Sustained</strong> — 5+ of 7 the quarter before too ·{" "}
          <strong>Organic</strong> — no sales jump over {mr.bigJumpQoq}% in a quarter or {mr.bigJumpYoy}% on the year,
          share count within ±{mr.maxShareChangePct}% · <strong>Clean profit</strong> — other income under{" "}
          {Math.round(mr.maxOtherIncomeShare * 100)}% of profit · <strong>Value</strong> — P/E ÷ yearly profit growth ≤{" "}
          {mr.maxPeg} · <strong>Board</strong> — a third or more independent. “?” means the data is missing.
        </p>
        <p>
          Screener-safe: one page every 2.5–5 s, at most {mr.fetchesPerHour} pages an hour across this basket and the
          background refresh ({cov.used_last_hour} used); names already tried skip for a week; everything pauses if
          Screener pushes back.
        </p>
      </PageHead>

      <MomList strong={data.strong} near={data.near} />

      <div className="nano-fill">
        <span className="status-line">
          Scored <strong>{cov.fresh}</strong> stocks with recent results and known ROCE / ROE
          {cov.to_try ? (
            <>
              {" "}
              · <strong>{cov.to_try}</strong> close to passing are missing the latest quarter
            </>
          ) : null}
        </span>
        {cov.to_try && !cov.paused_until ? (
          <>
            <button type="button" className="btn-fill" disabled={running} onClick={() => void fill("mom")}>
              {fillLabel("mom", `Fetch latest results (${Math.min(20, cov.to_try)})`)}
            </button>
            <button type="button" className="btn-fill-all" disabled={running} onClick={() => void fill("mom", true)}>
              Fetch up to 60
            </button>
          </>
        ) : null}
      </div>
      <RatioFill
        cov={cov}
        perHour={mr.fetchesPerHour}
        job={job}
        disabled={running}
        onFast={() => void fill("momratio", false, { fast: true })}
        onStop={() => void fill("momratio", false, { stop: true })}
      />
      {cov.paused_until ? (
        <p className="table-meta">
          Screener is paused until{" "}
          {new Date(cov.paused_until).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}.
        </p>
      ) : null}
      {fillNote("mom")}
      {fillNote("bse")}
    </div>
  );
}
