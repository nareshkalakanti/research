"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loading } from "@/components/Loading";
import { napkinUrl, tradingviewUrl, websiteUrl } from "@/lib/links";
import type { NanoFillJob, NanoPage, NanoStock } from "@/lib/nanocap-champs";
import type { LvPage } from "@/lib/listed-ventures";
import type { FaPage, FaStock } from "@/lib/fallen-angels";
import type { HgPage, HgStock } from "@/lib/hidden-gems";
import type { MomPage, MomStock } from "@/lib/momentum";

type Basket = "nano" | "lv" | "fa" | "hg" | "mom";
type Kind = NanoFillJob["kind"];
const BASKET_KEY = "nano-basket";

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
                  <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
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

function survLabel(s: FaStock["surveillance"]): string {
  if (!s) return "Not on a list";
  if (/ibc|insolvency/i.test(`${s.stage} ${s.desc}`)) return `${s.list} · insolvency (IBC)`;
  return s.list === "GSM" ? "GSM" : `${s.list} ${s.stage.replace(/^Stage\s*/i, "")}`.trim();
}

/** Fallen Angels: holdings (since mid-2025) or ranked candidates, with the score. */
function FaTable({ rows, holdings }: { rows: FaStock[]; holdings?: boolean }) {
  return (
    <div className="table-wrap nano-wrap">
      <table className="data-table nano-table">
        <thead>
          <tr>
            <th className="num" title="Recovery 50 · governance 30 · price 20 — hover a score for the breakdown">
              Score
            </th>
            <th className="nano-col-name">Stock</th>
            <th className="num">Value ₹ Cr</th>
            {holdings ? <th className="num">Since Jun 2025</th> : null}
            <th className="num" title="Price vs its 3-year high">From high</th>
            <th className="num" title="Price vs its 1-year low">Off low</th>
            <th className="num">Sales YoY</th>
            <th title="Latest quarter vs the same quarter last year">Profit</th>
            <th className="num" title="Quarters in a row with profit better than a year earlier">Qtrs ↑</th>
            <th className="num" title="Independent directors / board size">Indep / board</th>
            <th title="NSE surveillance list today">List</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ticker}>
              <td
                className="num nano-score"
                title={r.score_parts.map((p) => `${p.label}: ${p.points}/${p.max}`).join("\n")}
              >
                {r.score ?? "—"}
              </td>
              <td className="nano-col-name">
                <a className="nano-name" href={tradingviewUrl(r.ticker, r.market)} target="_blank" rel="noreferrer">
                  {r.name}
                </a>
                <span className="nano-meta">
                  {r.ticker}
                  <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                    NP
                  </a>
                  {r.group ? <span>· {r.group}</span> : null}
                </span>
              </td>
              <td className="num">{num(r.mcap_cr)}</td>
              {holdings ? <td className="num">{growth(r.since_entry_pct ?? null)}</td> : null}
              <td className="num">{growth(r.from_high_pct ?? null)}</td>
              <td className="num">{growth(r.from_low_pct ?? null)}</td>
              <td className="num">{growth(r.sales_yoy)}</td>
              <td>{r.profit_trend ?? "—"}</td>
              <td className="num">{r.improving_quarters || "—"}</td>
              <td className="num">{r.board ? `${r.independent} / ${r.board}` : "—"}</td>
              <td className="nano-group">{r.surveillance ? survLabel(r.surveillance) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmtQuarter(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })
    : iso;
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
function MomList({ strong, near, rules }: { strong: MomStock[]; near: MomStock[]; rules: MomPage["rules"] }) {
  const [show, setShow] = useState<"all" | "sb" | "buy">("all");
  const [cleanOnly, setCleanOnly] = useState(false);
  const all = [...strong, ...near].sort(
    (a, b) => b.passed - a.passed || b.quarter_score - a.quarter_score || (b.mcap_cr ?? 0) - (a.mcap_cr ?? 0),
  );
  const rows = all.filter(
    (r) =>
      (show === "all" || (show === "sb" ? r.passed >= 7 : r.passed === 6)) &&
      (!cleanOnly || r.checks.every((c) => c.ok !== false)),
  );
  const chip = (id: typeof show, label: string, n: number) => (
    <button type="button" className={`chip${show === id ? " on" : ""}`} onClick={() => setShow(id)}>
      {label} <span className="nano-count">{n}</span>
    </button>
  );
  return (
    <section className="nano-section">
      <div className="ss-filters">
        <div className="ss-chips" role="group" aria-label="Rating">
          {chip("all", "All", all.length)}
          {chip("sb", "Strong Buy", strong.length)}
          {chip("buy", "Buy", near.length)}
        </div>
        <label className="mom-clean">
          <input type="checkbox" checked={cleanOnly} onChange={(e) => setCleanOnly(e.target.checked)} /> Hide stocks
          with a failed check
        </label>
      </div>
      {rows.length ? <MomTable rows={rows} /> : <p className="miq-empty-hint">None right now.</p>}
      <p className="nano-note">
        Checks (hover a chip for the reason): <strong>Sustained</strong> — 5+ of 7 the quarter before too ·{" "}
        <strong>Organic</strong> — no sales jump over {rules.bigJumpQoq}% in a quarter or {rules.bigJumpYoy}% on the
        year, share count within ±{rules.maxShareChangePct}% · <strong>Clean profit</strong> — other income under{" "}
        {Math.round(rules.maxOtherIncomeShare * 100)}% of profit · <strong>Value</strong> — P/E ÷ yearly profit growth ≤{" "}
        {rules.maxPeg} · <strong>Board</strong> — a third or more independent. “?” means the data is missing.
      </p>
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
                  {r.checks.map((c) => (
                    <span
                      key={c.id}
                      className={`mom-ck ${c.ok === true ? "ok" : c.ok === false ? "bad" : "unk"}`}
                      title={c.note}
                    >
                      {c.ok === true ? "✓" : c.ok === false ? "✗" : "?"} {CHECK_LABEL[c.id]}
                    </span>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Hidden Gems: ATAM-like metrics, score and named funds. */
function HgTable({ rows, showStake }: { rows: HgStock[]; showStake?: boolean }) {
  return (
    <div className="table-wrap nano-wrap">
      <table className="data-table nano-table">
        <thead>
          <tr>
            <th className="num" title="Cheap 40 · record 25 · bad patch 20 · governance 15 — hover for breakdown">
              Score
            </th>
            <th className="nano-col-name">Stock</th>
            <th className="num">Value ₹ Cr</th>
            {showStake ? <th className="num" title="Trilithon Hidden Gems stake (latest filing)">Trilithon</th> : null}
            <th className="num" title="Market cap ÷ best 12-month profit in 3 years">P/E on best year</th>
            <th className="num" title="Market cap ÷ last 12 months' sales">Price / sales</th>
            <th className="num" title="Last 12 months' profit vs its best 12 months">Profit vs best</th>
            <th className="num" title="Share of reported periods (3 years) with an operating profit">Profitable</th>
            <th className="num" title="Price vs its 3-year high">From high</th>
            <th className="num" title="Borrowings ÷ net worth (latest annual)">Debt / equity</th>
            <th className="num" title="Independent directors / board size">Indep / board</th>
            <th title="Other funds named in the latest shareholding filing (over 1%)">Funds</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ticker}>
              <td className="num nano-score" title={r.score_parts.map((p) => `${p.label}: ${p.points}/${p.max}`).join("\n")}>
                {r.score ?? "—"}
              </td>
              <td className="nano-col-name">
                <a className="nano-name" href={tradingviewUrl(r.ticker, r.market)} target="_blank" rel="noreferrer">
                  {r.name}
                </a>
                <span className="nano-meta">
                  {r.ticker}
                  {r.market && r.market !== "NSE" ? <span>· {r.market}</span> : null}
                  <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                    NP
                  </a>
                </span>
              </td>
              <td className="num">{num(r.mcap_cr)}</td>
              {showStake ? (
                <td className="num" title={r.trilithon ? `Filing for ${fmtQuarter(r.trilithon.quarter)}` : ""}>
                  {r.trilithon?.pct != null ? `${r.trilithon.pct.toFixed(2)}%` : "—"}
                </td>
              ) : null}
              <td className="num">{num(r.pe_on_peak, 1)}</td>
              <td className="num">{num(r.price_to_sales, 2)}</td>
              <td className="num">{growth(r.profit_vs_peak_pct)}</td>
              <td className="num">{r.profitable_share != null ? `${Math.round(r.profitable_share * 100)}%` : "—"}</td>
              <td className="num">{growth(r.from_high_pct)}</td>
              <td className="num">{num(r.debt_to_equity, 2)}</td>
              <td className="num">{r.board_known ? `${r.independent} / ${r.board}` : "unknown"}</td>
              <td className="nano-group">{r.other_funds.length ? r.other_funds.slice(0, 2).join(", ") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Nanocap Champs, Listed Ventures, Fallen Angels and Hidden Gems: holdings, past picks and look-alikes. */
export function NanocapPanel() {
  const [basket, setBasket] = useState<Basket>(() => {
    try {
      const v = window.localStorage.getItem(BASKET_KEY);
      return v === "lv" || v === "fa" || v === "hg" || v === "mom" ? v : "nano";
    } catch {
      return "nano";
    }
  });
  const [data, setData] = useState<NanoPage | LvPage | FaPage | HgPage | MomPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<NanoFillJob | null>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nanocap?basket=${basket}`, { cache: "no-store" });
      const json = (await res.json()) as (NanoPage | LvPage | FaPage | HgPage | MomPage) & {
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
  }, [basket]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickBasket = (b: Basket) => {
    if (b === basket) return;
    setData(null);
    setBasket(b);
    try {
      window.localStorage.setItem(BASKET_KEY, b);
    } catch {
      /* per-viewer convenience only */
    }
  };

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
      kind === "quality"
        ? "ROCE"
        : kind === "momratio"
          ? "ROCE and ROE"
        : kind === "lv"
          ? "ROCE and results"
          : kind === "fa" || kind === "hgprice"
            ? "prices"
            : kind === "hgscan"
              ? "shareholding filings"
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

  const switcher = (
    <div className="nano-switch" role="tablist" aria-label="Basket">
      {(
        [
          ["nano", "Nanocap Champs"],
          ["lv", "Listed Ventures"],
          ["fa", "Fallen Angels"],
          ["hg", "Hidden Gems"],
          ["mom", "Momentum"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={basket === id}
          className={basket === id ? "on" : ""}
          onClick={() => pickBasket(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (error && !data) {
    return (
      <div className="panel nano-panel">
        {switcher}
        <p className="miq-empty-hint">Could not load: {error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="panel nano-panel">
        {switcher}
        <Loading
          label={
            basket === "lv"
              ? "Loading Listed Ventures"
              : basket === "fa"
                ? "Loading Fallen Angels"
                : basket === "hg"
                  ? "Loading Hidden Gems"
                  : basket === "mom"
                  ? "Scoring quarters for Momentum"
                  : "Loading Nanocap Champs"
          }
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
            results, prices and surveillance lists
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

  const fetchRow = (kind: Kind, cov: { to_try: number }, label: string) =>
    cov.to_try ? (
      <>
        <button type="button" className="btn-fill" disabled={running} onClick={() => void fill(kind)}>
          {fillLabel(kind, `${label} (25)`)}
        </button>
        <button type="button" className="btn-fill-all" disabled={running} onClick={() => void fill(kind, true)}>
          Fetch all {cov.to_try}
        </button>
      </>
    ) : null;

  if (data.basket === "mom") {
    const mr = data.rules;
    const cov = data.coverage;
    return (
      <div className="panel nano-panel">
        {switcher}
        {autoNote}
        <div className="missing-head">
          <div>
            <h2>Momentum</h2>
            <p className="missing-sub">
              7-Rule <strong>Strong Buy</strong> (7/7) or <strong>Buy</strong> (6/7) — ROCE and ROE over 15%, sales and
              profit up on last quarter and last year, margin up — <em>and</em> a Strong quarterly growth score (
              {mr.minQuarterScore}+/10).
            </p>
          </div>
        </div>

        <MomList strong={data.strong} near={data.near} rules={mr} />

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
        <p className="nano-note">
          Screener-safe: one page every 2.5–5 s, at most {mr.fetchesPerHour} pages an hour across this basket and the
          background refresh ({cov.used_last_hour} used), names already tried skip for a week, and everything pauses automatically if Screener
          pushes back.
          {cov.paused_until
            ? ` Screener is paused until ${new Date(cov.paused_until).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}.`
            : ""}
        </p>
        {fillNote("mom")}
      </div>
    );
  }

  if (data.basket === "hg") {
    const hr = data.rules;
    return (
      <div className="panel nano-panel">
        {switcher}
        {autoNote}
        <div className="missing-head">
          <div>
            <h2>Hidden Gems</h2>
            <p className="missing-sub">
              Tiny, ignored companies with a real earnings record, cheap against what they normally earn — the style of
              Trilithon Hidden Gems Scheme (Lotusdew), which holds ATAM.
            </p>
          </div>
        </div>

        <section className="nano-section">
          <h3>
            Trilithon&apos;s confirmed picks <span className="nano-count">{data.trilithon.length}</span>
          </h3>
          <p className="nano-note">
            Companies whose latest NSE shareholding filing names Trilithon Hidden Gems (stakes over 1% only — smaller
            ones stay hidden). Largest stake first.
          </p>
          {data.trilithon.length ? (
            <HgTable rows={data.trilithon} showStake />
          ) : (
            <p className="miq-empty-hint">
              {data.scan.scanned ? "None found in the filings scanned so far." : "Scan the filings to find their picks."}
            </p>
          )}
          <div className="nano-fill">
            <span className="status-line">
              Filings read for <strong>{data.scan.scanned}</strong> of {data.scan.universe} NSE and NSE SME companies
              under ₹{hr.scanMaxMcapCr.toLocaleString("en-IN")} Cr
              {data.scan.last_at
                ? ` · ${new Date(data.scan.last_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
                : ""}
              {data.scan.holders_found ? ` · ${data.scan.holders_found.toLocaleString("en-IN")} named holders saved` : ""}
            </span>
            <button type="button" className="btn-fill" disabled={running} onClick={() => void fill("hgscan")}>
              {fillLabel("hgscan", data.scan.scanned < data.scan.universe ? "Scan filings" : "Rescan filings")}
            </button>
            {fillNote("hgscan")}
          </div>
        </section>

        <section className="nano-section">
          <h3>
            ATAM-like now — top {data.candidates.length}
          </h3>
          <p className="nano-note">
            NSE, NSE SME and BSE SME · ₹{hr.minMcapCr}–{hr.maxMcapCr} Cr · P/E on its best year ≤ {hr.maxPeOnPeak} ·
            price ≤ {hr.maxPriceToSales}× sales · operating profit in {Math.round(hr.minProfitableShare * 100)}%+ of
            periods over 3 years · still profitable today · debt no more than equity where known · board at least a
            third independent where known · insolvency excluded. Ranked by score: cheap 40 · record 25 · bad patch 20 ·
            governance 15.
          </p>
          {data.candidates.length ? (
            <HgTable rows={data.candidates} />
          ) : (
            <p className="miq-empty-hint">No stocks pass every rule right now.</p>
          )}
          <div className="nano-fill">
            <span className="status-line">
              <strong>{data.shortlist}</strong> pass the numbers · price checked for <strong>{data.price_checked}</strong>
            </span>
            <button type="button" className="btn-fill" disabled={running} onClick={() => void fill("hgprice")}>
              {fillLabel("hgprice", data.price_checked < data.shortlist ? "Run price check" : "Refresh price check")}
            </button>
            {fillNote("hgprice")}
          </div>
        </section>

        <section className="nano-section">
          <h3>
            Your hidden gems <span className="nano-count">{data.holdings.length}</span>
          </h3>
          <p className="nano-note">From your Hidden Gems watchlist — add more there.</p>
          <HgTable rows={data.holdings} showStake />
        </section>
      </div>
    );
  }

  if (data.basket === "fa") {
    const fr = data.rules;
    const avg = (() => {
      const v = data.current.map((r) => r.since_entry_pct).filter((x): x is number => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    })();
    return (
      <div className="panel nano-panel">
        {switcher}
        {autoNote}
        <div className="missing-head">
          <div>
            <h2>Fallen Angels</h2>
            <p className="missing-sub">
              Our own recovery screen: companies that fell hard and whose results have genuinely turned, ranked by a
              score — recovery 50 · governance 30 · price 20. Lotusdew&apos;s picks are tracked below for comparison.
            </p>
          </div>
        </div>

        <section className="nano-section">
          <h3>
            On a surveillance list — their strategy <span className="nano-count">{data.on_list.length}</span>
          </h3>
          <p className="nano-note">
            On NSE&apos;s ASM or GSM list today ({data.surveillance_total} stocks), fallen and recovering, passing every
            rule below. This is how Lotusdew picks — ranked by our score.
          </p>
          {data.on_list.length ? (
            <FaTable rows={data.on_list} />
          ) : (
            <p className="miq-empty-hint">
              {data.price_checked ? "No surveillance-list stock passes every rule right now." : "Run the price check to rank stocks."}
            </p>
          )}
        </section>

        <section className="nano-section">
          <h3>
            Also recovering, not on a list — top {data.candidates.length}
          </h3>
          <p className="nano-note">
            NSE main board · ₹{fr.minMcapCr}–{fr.maxMcapCr.toLocaleString("en-IN")} Cr · price {fr.minFallPct}%+ below
            its 3-year high and {fr.minBouncePct}%+ off its 1-year low · sales up {fr.minSalesYoy}%+ and profit better
            than a year ago (a smaller loss counts) · at least a third of the board independent · insolvency (IBC)
            excluded. Hover a score for its breakdown.
          </p>
          {data.candidates.length ? (
            <FaTable rows={data.candidates} />
          ) : (
            <p className="miq-empty-hint">
              {data.price_checked ? "No stocks pass every rule right now." : "Run the price check to rank stocks."}
            </p>
          )}
          <div className="nano-fill">
            <span className="status-line">
              <strong>{data.shortlist}</strong> stocks pass the numbers · price checked for{" "}
              <strong>{data.price_checked}</strong>
              {data.price_checked_at
                ? ` · ${new Date(data.price_checked_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
                : ""}
            </span>
            <button type="button" className="btn-fill" disabled={running} onClick={() => void fill("fa")}>
              {fillLabel("fa", data.price_checked < data.shortlist ? "Run price check" : "Refresh price check")}
            </button>
            {fillNote("fa")}
          </div>
        </section>

        <section className="nano-section">
          <h3>
            Lotusdew&apos;s picks <span className="nano-count">{data.current.length}</span>
          </h3>
          <p className="nano-note">
            Bought mid-2025
            {avg != null ? ` · average ${avg > 0 ? "+" : ""}${Math.round(avg)}% since (equal weight)` : ""} · best
            first. Scored with today&apos;s numbers: the winners had results that turned; a strong board alone
            (Aptech) did not hold up.
          </p>
          <FaTable rows={data.current} holdings />
        </section>
      </div>
    );
  }

  if (data.basket === "lv") {
    const lr = data.rules;
    return (
      <div className="panel nano-panel">
        {switcher}
        {autoNote}
        <div className="missing-head">
          <div>
            <h2>Listed Ventures</h2>
            <p className="missing-sub">
              Growth compounders — ₹500–6,000 Cr, fast sales growth, high ROCE; valuation is not the filter.
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
          <h3>
            Past holdings <span className="nano-count">{data.past.length}</span>
          </h3>
          <p className="nano-note">
            From your LV historical list, largest first — several grew far past the band (Cupid, CDSL, Affle).
          </p>
          <StockTable rows={data.past} />
        </section>

        <section className="nano-section">
          <h3>
            Fits the pattern now <span className="nano-count">{data.candidates.length}</span>
          </h3>
          <p className="nano-note">
            NSE main board · ₹{lr.minMcapCr.toLocaleString("en-IN")}–{lr.maxMcapCr.toLocaleString("en-IN")} Cr · sales up{" "}
            {lr.minSalesYoy}%+ vs same quarter last year · profit up · ROCE ≥ {Math.round(lr.minRoce * 100)}% · P/E ≤{" "}
            {lr.maxPe} · at least {Math.round(lr.minIndependentShare * 100)}% of the board independent. Not in the
            basket now or before. Fastest sales growth first.
          </p>
          {data.candidates.length ? (
            <StockTable rows={data.candidates} />
          ) : (
            <p className="miq-empty-hint">No stocks pass every rule right now.</p>
          )}
          <div className="nano-fill">
            <span className="status-line">
              Checked <strong>{data.coverage.with_data}</strong> of {data.coverage.universe} stocks in the band
              {data.coverage.to_try ? (
                <>
                  {" "}· <strong>{data.coverage.to_try}</strong> still need ROCE or results
                </>
              ) : null}
              {data.coverage.missing - data.coverage.to_try > 0
                ? ` · ${data.coverage.missing - data.coverage.to_try} not on Screener`
                : ""}
            </span>
            {fetchRow("lv", data.coverage, "Fetch missing")}
            {fillNote("lv")}
          </div>
        </section>
      </div>
    );
  }

  const r = data.rules;
  const q = data.quality_rules;
  return (
    <div className="panel nano-panel">
      {switcher}
      {autoNote}
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
            {data.coverage.to_try ? ` · ${data.coverage.to_try} still to fetch` : ""}
            {data.coverage.missing - data.coverage.to_try > 0
              ? ` · ${data.coverage.missing - data.coverage.to_try} not on Screener`
              : ""}
          </span>
          {fetchRow("nano", data.coverage, "Fetch missing results")}
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
          {Math.round(q.minRoce * 100)}% · at least half the board independent · sales up vs
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
            {data.quality_coverage.missing - data.quality_coverage.to_try > 0
              ? ` · ${data.quality_coverage.missing - data.quality_coverage.to_try} not on Screener`
              : ""}
          </span>
          {fetchRow("quality", data.quality_coverage, "Fetch missing ROCE")}
          {fillNote("quality")}
        </div>
      </section>
    </div>
  );
}
