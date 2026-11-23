"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { HoldingsIndustryCheck, MultiPick } from "@/components/FilterBar";
import { MarketScoreChart } from "@/components/MarketScoreChart";
import { ReviewPlusButton } from "@/components/ReviewPlusButton";
import { napkinUrl, tradingviewUrl, websiteUrl } from "@/lib/links";
import { RevenueEarningsChart } from "@/components/RevenueEarningsChart";
import type { QuarterPanel } from "@/lib/quarter-panel";
import { useUrlEnumParam } from "@/lib/url-enum-param";

/**
 * Value page (dark): an Intrinsic Value style ranking tool — Sales growth 3Y,
 * ROCE 3Y and P/B ranked inside whatever set you filter to, ranks summed into a
 * total score (lower = better) — and industry Favour / Out of favour breadth
 * (Full Market + industries). Industries are StockScans'.
 */

type Stock = {
  t: string;
  name: string;
  market: string;
  sector: string | null;
  industry: string | null;
  mcap: number | null;
  web: string | null;
  sales3y: number | null;
  roce3y: number | null;
  pb: number | null;
  src?: "screener" | "upstox" | "yahoo" | null;
};
type Industry = { name: string; n: number; ranked: number };
type Wind = {
  industry: string;
  sector: string | null;
  n: number;
  above: number;
  below: number;
  score: number;
  ret3m: number | null;
  indicator: "FAVOUR" | "OUT" | "NEUTRAL";
  is_market?: boolean;
};
type Ranked = Stock & { gR: number; rR: number; pR: number; total: number; rank: number };
/** Unranked: no Sales growth / ROCE / P/B yet — listed after the ranked ones. */
type Row = Ranked | (Stock & { gR: null; rR: null; pR: null; total: null; rank: null });

type Filters = { q: string; industries: string[]; minCount: number; minCap: string; maxCap: string; exch: string };
/** Default: ₹200 Cr+ (tiny SME names otherwise crowd the top). */
const EMPTY: Filters = { q: "", industries: [], minCount: 0, minCap: "200", maxCap: "", exch: "all" };
const PAGE = 25;

const cr = (v: number | null) => (v == null ? "—" : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: v < 100 ? 2 : 0 })} Cr`);
const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}%`);

/** Rank each leg inside the set (ties share the lower rank), sum = total score. */
function rankSet(rows: Stock[]): Ranked[] {
  const work = rows.filter((r) => r.sales3y != null && r.roce3y != null && r.pb != null && r.pb > 0);
  const rankBy = (vals: Array<[string, number]>, desc: boolean) => {
    const s = [...vals].sort((a, b) => (desc ? b[1] - a[1] : a[1] - b[1]));
    const out = new Map<string, number>();
    s.forEach(([t, v], i) => out.set(t, i > 0 && v === s[i - 1]![1] ? out.get(s[i - 1]![0])! : i + 1));
    return out;
  };
  const g = rankBy(work.map((r) => [r.t, r.sales3y!]), true);
  const o = rankBy(work.map((r) => [r.t, r.roce3y!]), true);
  const p = rankBy(work.map((r) => [r.t, r.pb!]), false);
  return work
    .map((r) => {
      const gR = g.get(r.t)!;
      const rR = o.get(r.t)!;
      const pR = p.get(r.t)!;
      return { ...r, gR, rR, pR, total: gR + rR + pR, rank: 0 };
    })
    .sort((a, b) => a.total - b.total || a.gR - b.gR || a.rR - b.rR || a.pR - b.pR)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

type Job = { kind: string; running: boolean; done: number; total: number; filled: number; error: string | null } | null;

/** One line: what the 30-min background job has filled, and when it runs next. */
function AutoFillStatus() {
  type S = {
    last_run: string | null;
    next_run: string | null;
    tried_24h: number;
    filled_24h: number;
    screener_paused_until: string | null;
    pages_left_this_hour: number;
    job: Job & { kind?: string };
  };
  const [st, setSt] = useState<S | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const j = (await (await fetch("/api/value-tools?kind=auto", { cache: "no-store" })).json()) as S & { ok?: boolean };
        if (live && j.ok !== false) setSt(j);
      } catch {
        /* status is optional */
      }
    };
    void load();
    const id = window.setInterval(load, 60_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);
  if (!st) return null;
  const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");
  const running = !!st.job?.running && st.job.kind === "auto";
  return (
    <p className="vx-hint vx-auto">
      <span className={`vx-auto-dot${running ? " on" : st.screener_paused_until ? " paused" : ""}`} aria-hidden />
      Auto-fill (every 30 min while the app is open):{" "}
      {running ? `running now · ${st.job!.done} of ${st.job!.total}` : `last run ${hm(st.last_run)} · next ≈ ${hm(st.next_run)}`} ·{" "}
      {st.filled_24h} filled of {st.tried_24h} tried in 24 h ·{" "}
      {st.screener_paused_until
        ? `Screener paused until ${hm(st.screener_paused_until)}`
        : `Screener OK · ${st.pages_left_this_hour} pages left this hour`}
    </p>
  );
}

/** "Fetch missing data": Yahoo fill for stocks without Sales / ROCE / P/B. */
function FillBar({ missing, fetchable, onDone }: { missing: number; fetchable: number; onDone: () => void }) {
  const [job, setJob] = useState<Job>(null);
  const load = useCallback(async () => {
    try {
      const j = (await (await fetch("/api/value-tools?kind=job", { cache: "no-store" })).json()) as { job: Job };
      setJob(j.job);
      return j.job;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);
  const mine = !!job?.running && (job.kind === "rotqy" || job.kind === "valq");
  useEffect(() => {
    if (!mine) return;
    const id = window.setInterval(async () => {
      const j = await load();
      if (!j?.running) onDone();
    }, 5000);
    return () => window.clearInterval(id);
  }, [mine, load, onDone]);
  const post = async (body: object) => {
    const j = (await (
      await fetch("/api/value-tools", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    ).json()) as { job: Job };
    setJob(j.job);
  };
  if (!missing && !mine) return null;
  return (
    <>
    <div className="vx-fill">
      {mine ? (
        <>
          <span className="vx-fill-dot" aria-hidden />
          <span>
            Fetching Sales growth / ROCE / P/B (Yahoo, then Screener for the rest) · {job!.done.toLocaleString("en-IN")} of{" "}
            {job!.total.toLocaleString("en-IN")} · {job!.filled.toLocaleString("en-IN")} found
          </span>
          <button type="button" className="vx-btn" onClick={() => void post({ stop: true })}>
            Stop
          </button>
        </>
      ) : (
        <>
          <span>
            {missing.toLocaleString("en-IN")} stocks can&apos;t be ranked yet.{" "}
            {fetchable > 0 ? (
              <>
                {fetchable.toLocaleString("en-IN")} still need their data fetched
                {missing - fetchable > 0
                  ? `; ${(missing - fetchable).toLocaleString("en-IN")} have no usable data (new listing, sales of zero, negative book value or not on Screener)`
                  : ""}
                .
              </>
            ) : (
              <>All have been checked — they have no usable data (new listing, sales of zero, negative book value or not on Screener).</>
            )}
          </span>
          {fetchable > 0 ? (
            <button
              type="button"
              className="vx-btn"
              disabled={!!job?.running}
              title={
                job?.running
                  ? "Another background job is running — try again shortly"
                  : "Sales/ROCE first (never-fetched → gaps → failed), then P/B · Screener → Upstox → Yahoo · paced; stops if Screener pushes back"
              }
              onClick={() => void post({})}
            >
              Fetch next {Math.min(40, fetchable)}
            </button>
          ) : null}
        </>
      )}
    </div>
    <AutoFillStatus />
    </>
  );
}

const VALUE_SUBTABS = [
  "rank",
  "cycle",
  "valuation",
  "winds",
  "earnings",
] as const;
type ValueSubTab = (typeof VALUE_SUBTABS)[number];

export function ValuePanel() {
  const [tab, setTab] = useUrlEnumParam("v", VALUE_SUBTABS, "rank");
  const [rows, setRows] = useState<Stock[] | null>(null);
  const [industries, setIndustries] = useState<Industry[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(0);
  /** Bumped after a quality fill so the table picks up the new data. */
  const [reloadKey, setReloadKey] = useState(0);
  /** Unranked stocks Screener has not been asked about in the last 30 days. */
  const [fetchable, setFetchable] = useState(0);
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/value-tools?kind=universe", { cache: "no-store" });
        const j = (await res.json()) as {
          ok?: boolean;
          error?: string;
          rows?: Stock[];
          industries?: Industry[];
          as_of?: string | null;
          unranked_fetchable?: number;
        };
        if (!live) return;
        if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
        setRows(j.rows ?? []);
        setIndustries(j.industries ?? []);
        setAsOf(j.as_of ?? null);
        setFetchable(j.unranked_fetchable ?? 0);
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [reloadKey]);

  /** Can't rank until Sales growth 3Y, ROCE 3Y and P/B are all present. */
  const missingAll = useMemo(
    () => (rows ?? []).filter((r) => r.sales3y == null || r.roce3y == null || r.pb == null || r.pb <= 0).length,
    [rows],
  );

  const apply = useCallback((f: Filters) => {
    setApplied(f);
    setPage(0);
  }, []);

  // Filters apply as you change them; search waits until typing pauses.
  useEffect(() => {
    if (draft === applied) return;
    const typing = draft.q !== applied.q;
    const id = window.setTimeout(() => apply(draft), typing ? 250 : 0);
    return () => window.clearTimeout(id);
  }, [draft, applied, apply]);

  /** Open the ranking tool on one industry (from the wind list). */
  const openIndustry = useCallback(
    (name: string) => {
      // All sizes: the companies seen on Valuation / Cycle / Winds must be here too.
      const f = { ...EMPTY, industries: [name], minCap: "" };
      setDraft(f);
      apply(f);
      setTab("rank");
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [apply, setTab],
  );

  const ranked = useMemo(() => {
    if (!rows) return [];
    const counts = new Map(industries.map((i) => [i.name, i.n]));
    const min = Number(applied.minCap) || 0;
    const max = Number(applied.maxCap) || 0;
    const set = rows.filter((r) => {
      if (applied.industries.length && !applied.industries.includes(r.industry ?? "")) return false;
      if (applied.minCount && (counts.get(r.industry ?? "") ?? 0) < applied.minCount) return false;
      if (min && (r.mcap ?? 0) < min) return false;
      if (max && (r.mcap ?? Infinity) > max) return false;
      if (applied.exch !== "all" && (r.market || "NSE").toUpperCase() !== applied.exch) return false;
      return true;
    });
    // Rank the whole filtered set, then search only narrows what is shown.
    const done = rankSet(set);
    const have = new Set(done.map((r) => r.t));
    const rest = set
      .filter((r) => !have.has(r.t))
      .sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0))
      .map((r) => ({ ...r, gR: null, rR: null, pR: null, total: null, rank: null }));
    const all: Row[] = [...done, ...rest];
    const q = applied.q.trim().toLowerCase();
    return q ? all.filter((r) => r.name.toLowerCase().includes(q) || r.t.toLowerCase().includes(q)) : all;
  }, [rows, industries, applied]);
  const rankedN = useMemo(() => ranked.filter((r) => r.rank != null).length, [ranked]);

  const unranked = ranked.length - rankedN;

  const pages = Math.max(1, Math.ceil(ranked.length / PAGE));
  const shown = ranked.slice(page * PAGE, page * PAGE + PAGE);
  const nInd = new Set(ranked.map((r) => r.industry)).size;

  return (
    <section className="vx">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">
            {tab === "rank"
              ? "Market analysis tool"
              : tab === "cycle"
                ? "Industry cycle map"
                : tab === "valuation"
                  ? "Sector valuation"
                  : tab === "earnings"
                    ? "Wealth & analytics"
                  : "Favour / out of favour breadth"}
          </span>
          <h2 className="vx-title">
            {tab === "rank" ? (
              <>
                Intrinsic Value <span>Ranking</span>
              </>
            ) : tab === "cycle" ? (
              <>
                Industry <span>Cycle</span>
              </>
            ) : tab === "valuation" ? (
              <>
                Undervalued &amp; <span>Overvalued Sectors</span>
              </>
            ) : tab === "earnings" ? (
              <>
                Earnings <span>Trends</span>
              </>
            ) : (
              <>
                Favour / <span>Out of favour</span>
              </>
            )}
          </h2>
        </div>
        <div className="vx-tabs" role="tablist" aria-label="Value tools">
          <button type="button" role="tab" aria-selected={tab === "rank"} className={tab === "rank" ? "on" : ""} onClick={() => setTab("rank")}>
            Ranking tool
          </button>
          <button type="button" role="tab" aria-selected={tab === "cycle"} className={tab === "cycle" ? "on" : ""} onClick={() => setTab("cycle")}>
            Industry cycle
          </button>
          <button type="button" role="tab" aria-selected={tab === "valuation"} className={tab === "valuation" ? "on" : ""} onClick={() => setTab("valuation")}>
            Valuation
          </button>
          <button type="button" role="tab" aria-selected={tab === "earnings"} className={tab === "earnings" ? "on" : ""} onClick={() => setTab("earnings")}>
            Earnings Trends
          </button>
          <button type="button" role="tab" aria-selected={tab === "winds"} className={tab === "winds" ? "on" : ""} onClick={() => setTab("winds")}>
            Favour / Out of favour
          </button>
        </div>
      </header>

      {err ? <p className="vx-msg vx-msg--err">Could not load: {err}</p> : null}

      {tab === "rank" ? (
        <>
          <form
            className="vx-card vx-filters"
            onSubmit={(e) => {
              e.preventDefault();
              apply(draft);
            }}
          >
            <span className="vx-label vx-label--title">Filters</span>
            <div className="vx-grid">
              <label className="vx-field vx-field--wide">
                <span className="vx-label">Search company</span>
                <input
                  value={draft.q}
                  onChange={(e) => setDraft({ ...draft, q: e.target.value })}
                  placeholder="Search by company, NSE or BSE code"
                />
              </label>
              <div className="vx-field vx-field--wide vx-field--pick">
                <span className="vx-label">&nbsp;</span>
                <div className="vx-pick-row">
                  <MultiPick
                    label="Industry"
                    allLabel="All industries"
                    values={draft.industries}
                    onChange={(v) => setDraft({ ...draft, industries: v })}
                    options={industries.map((i) => ({ id: i.name, label: i.name, count: i.n, title: `${i.ranked} of ${i.n} ranked` }))}
                    searchable
                  />
                  <HoldingsIndustryCheck
                    values={draft.industries}
                    onChange={(v) => setDraft({ ...draft, industries: v })}
                    available={industries.map((i) => i.name)}
                  />
                </div>
              </div>
              <label className="vx-field">
                <span className="vx-label">Stock count</span>
                <select value={draft.minCount} onChange={(e) => setDraft({ ...draft, minCount: Number(e.target.value) })}>
                  <option value={0}>No filter</option>
                  {[5, 10, 20, 50].map((n) => (
                    <option key={n} value={n}>
                      Industries with {n}+ stocks
                    </option>
                  ))}
                </select>
              </label>
              <label className="vx-field">
                <span className="vx-label">Min market cap</span>
                <input inputMode="numeric" value={draft.minCap} onChange={(e) => setDraft({ ...draft, minCap: e.target.value.replace(/[^\d.]/g, "") })} placeholder="₹ Cr" />
              </label>
              <label className="vx-field">
                <span className="vx-label">Max market cap</span>
                <input inputMode="numeric" value={draft.maxCap} onChange={(e) => setDraft({ ...draft, maxCap: e.target.value.replace(/[^\d.]/g, "") })} placeholder="₹ Cr" />
              </label>
              <label className="vx-field">
                <span className="vx-label">Exchange</span>
                <select value={draft.exch} onChange={(e) => setDraft({ ...draft, exch: e.target.value })}>
                  <option value="all">All</option>
                  <option value="NSE">NSE</option>
                  <option value="NSE SME">NSE SME</option>
                  <option value="BSE">BSE</option>
                  <option value="BSE SME">BSE SME</option>
                </select>
              </label>
            </div>
            <div className="vx-actions">
              <button
                type="button"
                className="vx-btn"
                onClick={() => {
                  setDraft(EMPTY);
                  apply(EMPTY);
                }}
              >
                Reset
              </button>
              <span className="vx-hint">Filters apply instantly · ranks are recomputed inside the filtered set · lower total score = better</span>
            </div>
          </form>

          {rows ? <FillBar missing={missingAll} fetchable={fetchable} onDone={reload} /> : null}

          <div className="vx-kpis">
            <div className="vx-card vx-kpi">
              <span className="vx-label">Companies shown</span>
              <strong>{rows ? ranked.length.toLocaleString("en-IN") : "…"}</strong>
              {rows && unranked ? (
                <span className="vx-kpi-sub">
                  {rankedN.toLocaleString("en-IN")} ranked · {unranked.toLocaleString("en-IN")} no data yet
                </span>
              ) : null}
            </div>
            <div className="vx-card vx-kpi">
              <span className="vx-label">Industries</span>
              <strong>{rows ? nInd : "…"}</strong>
            </div>
            <div className="vx-card vx-kpi vx-kpi--best">
              <span className="vx-label">Best ranked</span>
              <strong>{ranked[0]?.rank ? ranked[0].name : "—"}</strong>
            </div>
          </div>

          <div className="vx-card vx-table-card">
            <div className="vx-table-head">
              <span className="vx-label vx-label--title">Ranked companies</span>
              <span className="vx-hint">
                {unranked ? `${unranked.toLocaleString("en-IN")} without Sales / ROCE / P/B yet (listed last) · ` : ""}
                {asOf ? `data to ${asOf.slice(0, 10)}` : ""}
              </span>
            </div>
            <div className="vx-scroll">
              <table className="vx-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Company</th>
                    <th>Industry</th>
                    <th className="num">Market cap</th>
                    <th className="num">Sales growth 3Y ↑</th>
                    <th className="num">ROCE 3Y ↑</th>
                    <th className="num">P/B ↓</th>
                    <th className="num">Total score</th>
                  </tr>
                </thead>
                <tbody>
                  {!rows ? (
                    <tr>
                      <td colSpan={10} className="vx-empty">
                        Loading…
                      </td>
                    </tr>
                  ) : !shown.length ? (
                    <tr>
                      <td colSpan={10} className="vx-empty">
                        No companies match these filters.
                      </td>
                    </tr>
                  ) : (
                    shown.map((r) => {
                      const web = websiteUrl(r.web);
                      return (
                        <tr key={r.t} className={r.rank === 1 ? "is-best" : undefined}>
                          <td className="vx-rank">{r.rank ?? "—"}</td>
                          <td>
                            <a className="vx-co" href={tradingviewUrl(r.t, r.market)} target="_blank" rel="noopener noreferrer">
                              {r.name}
                            </a>
                            <span className="vx-sub">
                              {r.t}
                              {r.market !== "NSE" ? <em>{r.market}</em> : null}
                              <ReviewPlusButton ticker={r.t} />
                              <a className="np-chip" href={napkinUrl(r.t)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                                NP
                              </a>
                              {web ? (
                                <a className="np-chip" href={web} target="_blank" rel="noopener noreferrer" title={r.web ?? ""}>
                                  Web
                                </a>
                              ) : null}
                            </span>
                          </td>
                          <td>
                            <button type="button" className="vx-link" onClick={() => openIndustry(r.industry ?? "")} title="Rank this industry only">
                              {r.industry ?? "—"}
                            </button>
                          </td>
                          <td className="num">{cr(r.mcap)}</td>
                          <td className="num">
                            <span
                              title={
                                r.src === "yahoo"
                                  ? "From Yahoo (no Screener annual data cached yet)"
                                  : r.src === "upstox"
                                    ? "From Upstox Fundamentals (free Analytics Token)"
                                    : r.src === "screener"
                                      ? "Screener: 3-year sales CAGR"
                                      : undefined
                              }
                            >
                              {pct(r.sales3y)}
                              {r.src === "yahoo" ? <sup className="vx-src">Y</sup> : null}
                              {r.src === "upstox" ? <sup className="vx-src">U</sup> : null}
                            </span>{" "}
                            {r.gR != null ? <span className="vx-r">({r.gR})</span> : null}
                          </td>
                          <td className={`num ${(r.roce3y ?? 0) < 0 ? "neg" : ""}`}>
                            {pct(r.roce3y)} {r.rR != null ? <span className="vx-r">({r.rR})</span> : null}
                          </td>
                          <td className="num">
                            {r.pb != null ? r.pb.toFixed(2) : "—"} {r.pR != null ? <span className="vx-r">({r.pR})</span> : null}
                          </td>
                          <td className="num vx-total">{r.total ?? <span className="vx-nodata">No data yet</span>}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="vx-pager">
              <button type="button" className="vx-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span className="vx-hint">
                Page {page + 1} of {pages}
              </span>
              <button type="button" className="vx-btn" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          </div>
        </>
      ) : tab === "cycle" ? (
        <CycleView rows={rows} onOpen={openIndustry} />
      ) : tab === "valuation" ? (
        <ValuationView onOpen={openIndustry} />
      ) : tab === "earnings" ? (
        <EarningsTrendsView universe={rows} />
      ) : (
        <WindsView onOpen={openIndustry} />
      )}
    </section>
  );
}

const WIND_LABEL: Record<Wind["indicator"], string> = {
  FAVOUR: "In favour",
  OUT: "Out of favour",
  NEUTRAL: "Neutral",
};

function WindsView({ onOpen }: { onOpen: (industry: string) => void }) {
  const [rows, setRows] = useState<Wind[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState<"all" | Wind["indicator"]>("all");
  const [q] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [minN, setMinN] = useState(1);
  /** Market Score history — Full Market only; expands under that row. */
  const [marketScoreOpen, setMarketScoreOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/value-tools?kind=winds", { cache: "no-store" });
        const j = (await res.json()) as { ok?: boolean; error?: string; rows?: Wind[]; as_of?: string | null };
        if (!live) return;
        if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
        setRows(j.rows ?? []);
        setAsOf(j.as_of ?? null);
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const counts = useMemo(() => {
    const c = { FAVOUR: 0, OUT: 0, NEUTRAL: 0 };
    for (const r of rows ?? []) {
      if (r.is_market) continue;
      if (r.n >= minN) c[r.indicator]++;
    }
    return c;
  }, [rows, minN]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const industries = (rows ?? []).filter(
      (r) =>
        !r.is_market &&
        r.n >= minN &&
        (show === "all" || r.indicator === show) &&
        (!needle || r.industry.toLowerCase().includes(needle)) &&
        (!picked.length || picked.includes(r.industry)),
    );
    const market = (rows ?? []).find((r) => r.is_market);
    // Full Market stays pinned on top whenever the list is showing.
    return market && (show === "all" || market.indicator === show) ? [market, ...industries] : industries;
  }, [rows, show, q, minN, picked]);

  return (
    <>
      <div className="vx-card vx-wind-bar">
        <div className="vx-seg" role="group" aria-label="Show">
          {(
            [
              ["all", "All", (rows ?? []).filter((r) => !r.is_market && r.n >= minN).length],
              ["FAVOUR", "In favour", counts.FAVOUR],
              ["NEUTRAL", "Neutral", counts.NEUTRAL],
              ["OUT", "Out of favour", counts.OUT],
            ] as const
          ).map(([id, label, n]) => (
            <button key={id} type="button" className={show === id ? "on" : ""} aria-pressed={show === id} onClick={() => setShow(id)}>
              {label}
              <span>{n}</span>
            </button>
          ))}
        </div>
        <label className="vx-field vx-field--inline">
          <span className="vx-label">Min stocks</span>
          <select value={minN} onChange={(e) => setMinN(Number(e.target.value))}>
            {[1, 2, 3, 5, 10, 20].map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
          </select>
        </label>
        <MultiPick
          label="Industry"
          allLabel="All industries"
          values={picked}
          onChange={setPicked}
          options={(rows ?? [])
            .filter((r) => !r.is_market && r.n >= minN)
            .map((r) => ({ id: r.industry, label: r.industry, count: r.n }))
            .sort((a, b) => a.label.localeCompare(b.label))}
          searchable
        />
        <HoldingsIndustryCheck
          values={picked}
          onChange={setPicked}
          available={(rows ?? []).filter((r) => !r.is_market && r.n >= minN).map((r) => r.industry)}
        />
        <span className="vx-hint vx-push">
          Favour / out of favour from breadth vs 50-day average{asOf ? ` · prices to ${asOf}` : ""}
          {" · click Full Market to open score history below"}
        </span>
      </div>

      <div className="vx-card vx-winds">
        {err ? (
          <p className="vx-msg vx-msg--err">Could not load: {err}</p>
        ) : !rows ? (
          <p className="vx-empty">Reading prices for every industry…</p>
        ) : !list.length ? (
          <p className="vx-empty">No industries match.</p>
        ) : (
          list.map((r) => {
            const w = Math.min(1, Math.abs(r.score)) * 50;
            const tone = r.indicator === "FAVOUR" ? "favour" : r.indicator === "OUT" ? "out" : "neutral";
            return (
              <Fragment key={r.industry}>
                <div
                  className={`vx-wind vx-wind--${tone}${r.is_market ? " vx-wind--market" : ""}${r.is_market && marketScoreOpen ? " vx-wind--selected" : ""}`}
                >
                  {r.is_market ? (
                    <button
                      type="button"
                      className="vx-wind-name vx-wind-name--market"
                      title={marketScoreOpen ? "Hide Full Market score history" : "Show Full Market score history"}
                      aria-expanded={marketScoreOpen}
                      onClick={() => setMarketScoreOpen((o) => !o)}
                    >
                      {r.industry}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="vx-wind-name"
                      onClick={() => onOpen(r.industry)}
                      title="Open in the ranking tool"
                    >
                      {r.industry}
                      <span aria-hidden>↗</span>
                    </button>
                  )}
                  <span className="vx-wind-meta">
                    {r.n.toLocaleString("en-IN")} stocks · {r.above} up / {r.below} down
                    {r.ret3m != null ? ` · 3M ${r.ret3m >= 0 ? "+" : ""}${r.ret3m.toFixed(1)}%` : ""}
                  </span>
                  <span className="vx-meter" aria-hidden>
                    <span className="vx-meter-mid" />
                    <span
                      className="vx-meter-fill"
                      style={r.score >= 0 ? { left: "50%", width: `${w}%` } : { left: `${50 - w}%`, width: `${w}%` }}
                    />
                  </span>
                  <span className="vx-wind-score">
                    {r.score > 0 ? "+" : ""}
                    {Number(r.score.toFixed(4))}
                  </span>
                  <span className="vx-badge">
                    {r.indicator === "FAVOUR" ? "▲ " : r.indicator === "OUT" ? "▼ " : "• "}
                    {WIND_LABEL[r.indicator]}
                  </span>
                </div>
                {r.is_market && marketScoreOpen ? (
                  <div className="vx-wind-score-panel">
                    <MarketScoreChart industry="Full Market" />
                  </div>
                ) : null}
              </Fragment>
            );
          })
        )}
      </div>
    </>
  );
}

// ---- Industry cycle -------------------------------------------------------------------

type CycleStatus = "deep_out" | "out" | "extreme_hot" | "hot" | "neutral";
type CycleRow = {
  industry: string;
  status: CycleStatus;
  ret3y: number | null;
  ret5y: number | null;
  n: number;
  cov3y: number;
  cov5y: number;
};
const CYCLE_LABEL: Record<CycleStatus, string> = {
  deep_out: "Deep out of favour",
  out: "Out of favour",
  neutral: "Neutral",
  hot: "Hot",
  extreme_hot: "Extremely hot",
};
const CYCLE_RULE: Record<CycleStatus, string> = {
  deep_out: "5Y < 2% a year",
  out: "3Y < 0% a year",
  extreme_hot: "5Y > 35% a year",
  hot: "3Y > 25% a year",
  neutral: "everything else",
};
const PICKS_MIN_CAP = 200;
const PICKS_PER_INDUSTRY = 3;

function CycleView({
  rows,
  onOpen,
}: {
  rows: Stock[] | null;
  onOpen: (industry: string) => void;
}) {
  const [data, setData] = useState<CycleRow[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState<CycleStatus | "all" | "picks" | "outlist">("picks");
  const [minN, setMinN] = useState(1);
  const [q] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/value-tools?kind=cycle", { cache: "no-store" });
        const j = (await res.json()) as { ok?: boolean; error?: string; rows?: CycleRow[]; as_of?: string | null };
        if (!live) return;
        if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
        setData(j.rows ?? []);
        setAsOf(j.as_of ?? null);
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const eligible = useMemo(() => (data ?? []).filter((r) => r.n >= minN), [data, minN]);
  const counts = useMemo(() => {
    const c: Record<CycleStatus, number> = { deep_out: 0, out: 0, neutral: 0, hot: 0, extreme_hot: 0 };
    for (const r of eligible) c[r.status]++;
    return c;
  }, [eligible]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return eligible.filter(
      (r) =>
        (show === "all" ||
          show === "picks" ||
          (show === "outlist" ? r.status === "deep_out" || r.status === "out" : r.status === show)) &&
        (!needle || r.industry.toLowerCase().includes(needle)) &&
        (!picked.length || picked.includes(r.industry)),
    );
  }, [eligible, show, q, picked]);
  const shownList = useMemo(
    () =>
      show === "outlist"
        ? [...list].sort((a, b) => (a.status === b.status ? (a.ret3y ?? 0) - (b.ret3y ?? 0) : a.status === "deep_out" ? -1 : 1))
        : list,
    [list, show],
  );

  /** Funnel: out-of-favour industries → rank inside each → top 3 over ₹200 Cr. */
  const picks = useMemo(() => {
    if (!rows || show !== "picks") return [];
    const out = list.filter((r) => r.status === "deep_out" || r.status === "out");
    return out
      .map((c) => {
        const ranked = rankSet(rows.filter((s) => s.industry === c.industry));
        const top = ranked.filter((s) => (s.mcap ?? 0) >= PICKS_MIN_CAP).slice(0, PICKS_PER_INDUSTRY);
        return { c, top, rankedN: ranked.length };
      })
      .filter((g) => g.top.length);
  }, [rows, list, show]);
  const pickCount = picks.reduce((a, g) => a + g.top.length, 0);

  return (
    <>
      <div className="vx-cyc-sum" role="group" aria-label="Industry cycle summary">
        {(["deep_out", "out", "extreme_hot", "hot", "neutral"] as CycleStatus[]).map((st) => (
          <button
            key={st}
            type="button"
            className={`vx-cyc-box vx-cyc-box--${st}${show === st ? " on" : ""}`}
            aria-pressed={show === st}
            onClick={() => setShow((cur) => (cur === st ? "all" : st))}
          >
            <span className="vx-cyc-box-k">{CYCLE_LABEL[st]}</span>
            <strong>{data ? counts[st] : "…"}</strong>
            <span className="vx-cyc-box-rule">{CYCLE_RULE[st]}</span>
          </button>
        ))}
      </div>
      <div className="vx-card vx-wind-bar">
        <div className="vx-seg" role="group" aria-label="Show">
          <button type="button" className={show === "picks" ? "on" : ""} aria-pressed={show === "picks"} onClick={() => setShow("picks")}>
            Out-of-favour picks
          </button>
          <button
            type="button"
            className={show === "outlist" ? "on" : ""}
            aria-pressed={show === "outlist"}
            onClick={() => setShow("outlist")}
          >
            Deep + out of favour list<span>{counts.deep_out + counts.out}</span>
          </button>
          <button type="button" className={show === "all" ? "on" : ""} aria-pressed={show === "all"} onClick={() => setShow("all")}>
            All industries<span>{eligible.length}</span>
          </button>
        </div>
        <label className="vx-field vx-field--inline">
          <span className="vx-label">Min companies</span>
          <select value={minN} onChange={(e) => setMinN(Number(e.target.value))}>
            {[1, 2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
          </select>
        </label>
        <MultiPick
          label="Industry"
          allLabel="All industries"
          values={picked}
          onChange={setPicked}
          options={eligible.map((r) => ({ id: r.industry, label: r.industry, count: r.n })).sort((a, b) => a.label.localeCompare(b.label))}
          searchable
        />
        <HoldingsIndustryCheck values={picked} onChange={setPicked} available={eligible.map((r) => r.industry)} />
      </div>
      <p className="vx-hint vx-cycle-rule">
        Average company return per year · Deep out of favour: 5Y &lt; 2% · Out of favour: 3Y &lt; 0% · Extremely hot: 5Y &gt; 35% · Hot: 3Y
        &gt; 25% · Neutral: rest{asOf ? ` · prices to ${asOf}` : ""}
      </p>

      {err ? (
        <p className="vx-msg vx-msg--err">Could not load: {err}</p>
      ) : !data ? (
        <p className="vx-empty">Reading 5 years of prices for every industry…</p>
      ) : show === "picks" ? (
        <div className="vx-card vx-table-card">
          <div className="vx-table-head">
            <span className="vx-label vx-label--title">
              Top {PICKS_PER_INDUSTRY} from each out-of-favour industry · ₹{PICKS_MIN_CAP} Cr+
            </span>
            <span className="vx-hint">
              {pickCount} companies from {picks.length} industries · ranked on Sales growth 3Y, ROCE 3Y and P/B inside each industry
            </span>
          </div>
          <div className="vx-scroll">
            <table className="vx-table">
              <thead>
                <tr>
                  <th>Industry / company</th>
                  <th className="num">3Y / 5Y return</th>
                  <th className="num">Market cap</th>
                  <th className="num">Sales growth 3Y</th>
                  <th className="num">ROCE 3Y</th>
                  <th className="num">P/B</th>
                  <th className="num">Rank</th>
                </tr>
              </thead>
              <tbody>
                {picks.map(({ c, top, rankedN }) => (
                  <Fragment key={c.industry}>
                    <tr className="vx-grp">
                      <td>
                        <button type="button" className="vx-link vx-grp-name" onClick={() => onOpen(c.industry)} title="Open in the ranking tool">
                          {c.industry} ↗
                        </button>
                        <span className={`vx-cyc vx-cyc--${c.status}`}>{CYCLE_LABEL[c.status]}</span>
                      </td>
                      <td className="num">
                        <span className={(c.ret3y ?? 0) < 0 ? "neg" : ""}>{pct(c.ret3y)}</span> /{" "}
                        <span className={(c.ret5y ?? 0) < 0 ? "neg" : ""}>{pct(c.ret5y)}</span>
                      </td>
                      <td colSpan={5} className="vx-hint">
                        {c.n} companies · {rankedN} ranked
                      </td>
                    </tr>
                    {top.map((r) => (
                      <tr key={r.t}>
                        <td className="vx-pick">
                          <a className="vx-co" href={tradingviewUrl(r.t, r.market)} target="_blank" rel="noopener noreferrer">
                            {r.name}
                          </a>
                          <span className="vx-sub">
                            {r.t}
                            {r.market !== "NSE" ? <em>{r.market}</em> : null}
                            <ReviewPlusButton ticker={r.t} />
                            <a className="np-chip" href={napkinUrl(r.t)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                              NP
                            </a>
                            {websiteUrl(r.web) ? (
                              <a className="np-chip" href={websiteUrl(r.web)!} target="_blank" rel="noopener noreferrer" title={r.web ?? ""}>
                                Web
                              </a>
                            ) : null}
                          </span>
                        </td>
                        <td />
                        <td className="num">{cr(r.mcap)}</td>
                        <td className="num">
                          {pct(r.sales3y)} <span className="vx-r">({r.gR})</span>
                        </td>
                        <td className="num">
                          {pct(r.roce3y)} <span className="vx-r">({r.rR})</span>
                        </td>
                        <td className="num">
                          {r.pb?.toFixed(2)} <span className="vx-r">({r.pR})</span>
                        </td>
                        <td className="num vx-total">
                          #{r.rank} <span className="vx-r">· {r.total}</span>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="vx-card vx-table-card">
          <div className="vx-scroll">
            <table className="vx-table">
              <thead>
                <tr>
                  <th>Industry</th>
                  <th>Status</th>
                  <th className="num">3Y avg return</th>
                  <th className="num">5Y avg return</th>
                  <th className="num">Companies</th>
                  <th className="num">Data coverage (3Y / 5Y)</th>
                </tr>
              </thead>
              <tbody>
                {shownList.map((r) => (
                  <tr key={r.industry}>
                    <td>
                      <button type="button" className="vx-link" onClick={() => onOpen(r.industry)} title="Rank this industry">
                        {r.industry} ↗
                      </button>
                    </td>
                    <td>
                      <span className={`vx-cyc vx-cyc--${r.status}`}>{CYCLE_LABEL[r.status]}</span>
                    </td>
                    <td className={`num ${(r.ret3y ?? 0) < 0 ? "neg" : ""}`}>{pct(r.ret3y)}</td>
                    <td className={`num ${(r.ret5y ?? 0) < 0 ? "neg" : ""}`}>{pct(r.ret5y)}</td>
                    <td className="num">{r.n}</td>
                    <td className="num vx-r">
                      {r.cov3y} / {r.cov5y}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ---- Valuation: top 15 undervalued / overvalued sectors ------------------------------------

type ValStock = { t: string; name: string; pe: number; peMedian: number; ratio: number; verdict: "under" | "fair" | "over" };
type ValSector = {
  industry: string;
  n: number;
  scored: number;
  under: number;
  over: number;
  under_pct: number;
  over_pct: number;
  stocks: ValStock[];
};
type ValDistBucket = { key: string; label: string; n: number };
type ValDistribution = { analyzed: number; buckets: ValDistBucket[] };
type ValMcapSegment = { key: string; label: string; n: number; under_pct: number; over_pct: number };

type ValOpen = { industry: string; side: "under" | "over" } | null;

function fmtPct1(n: number): string {
  return `${n % 1 ? n.toFixed(1) : n}%`;
}

function ValuationGraphs({
  dist,
  segments,
}: {
  dist: ValDistribution | null;
  segments: ValMcapSegment[] | null;
}) {
  const [open, setOpen] = useState(false);
  const maxN = Math.max(1, ...(dist?.buckets.map((b) => b.n) ?? [1]));
  const maxUnder = Math.max(1, ...(segments?.map((s) => s.under_pct) ?? [1]));
  const maxOver = Math.max(1, ...(segments?.map((s) => s.over_pct) ?? [1]));
  return (
    <div className={`vx-card vx-vgraph${open ? " vx-vgraph--open" : ""}`}>
      <button
        type="button"
        className="vx-vgraph-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="vx-vgraph-toggle-title">
          Valuation &amp; Trend Graphs
          <span className="vx-vgraph-chevron" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        </span>
        <span className="vx-vgraph-toggle-hint">{open ? "Hide graphs" : "Show graphs"}</span>
      </button>
      {open ? (
        <div className="vx-vgraph-body">
          <div className="vx-vdist">
            <div className="vx-vdist-head">
              <h3 className="vx-vdist-title">Valuation Distribution</h3>
              <span
                className="vx-vdist-badge"
                title="Only companies with ≥3 years of own year-end P/E (price ÷ EPS) in cache — not the full market list"
              >
                Scored: {(dist?.analyzed ?? 0).toLocaleString("en-IN")}
                <span className="vx-vdist-badge-note"> · ≥3Y own P/E</span>
              </span>
            </div>
            {!dist ? (
              <p className="vx-empty">Loading distribution…</p>
            ) : (
              <div className="vx-vdist-list">
                {dist.buckets.map((b) => (
                  <div key={b.key} className="vx-vdist-row">
                    <span className="vx-vdist-label">{b.label}</span>
                    <span className="vx-vdist-track" aria-hidden>
                      <span
                        className="vx-vdist-fill"
                        style={{ width: `${Math.max(b.n ? 4 : 0, (b.n / maxN) * 100)}%` }}
                      />
                    </span>
                    <span className="vx-vdist-n">{b.n.toLocaleString("en-IN")}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="vx-vseg-grid">
            <div className="vx-vseg">
              <h3 className="vx-vdist-title">Segment Undervaluation %</h3>
              {!segments ? (
                <p className="vx-empty">Loading…</p>
              ) : (
                <div className="vx-vdist-list">
                  {segments.map((s) => (
                    <div key={`u-${s.key}`} className="vx-vdist-row vx-vdist-row--seg">
                      <span className="vx-vdist-label">{s.label}</span>
                      <span className="vx-vdist-track" aria-hidden>
                        <span
                          className="vx-vdist-fill"
                          style={{ width: `${Math.max(s.under_pct ? 3 : 0, (s.under_pct / maxUnder) * 100)}%` }}
                        />
                      </span>
                      <span className="vx-vdist-n">{fmtPct1(s.under_pct)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="vx-vseg">
              <h3 className="vx-vdist-title">Segment Overvaluation %</h3>
              {!segments ? (
                <p className="vx-empty">Loading…</p>
              ) : (
                <div className="vx-vdist-list">
                  {segments.map((s) => (
                    <div key={`o-${s.key}`} className="vx-vdist-row vx-vdist-row--seg">
                      <span className="vx-vdist-label">{s.label}</span>
                      <span className="vx-vdist-track" aria-hidden>
                        <span
                          className="vx-vdist-fill"
                          style={{ width: `${Math.max(s.over_pct ? 3 : 0, (s.over_pct / maxOver) * 100)}%` }}
                        />
                      </span>
                      <span className="vx-vdist-n">{fmtPct1(s.over_pct)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Bars({
  title,
  rows,
  side,
  open,
  setOpen,
}: {
  title: string;
  rows: ValSector[];
  side: "under" | "over";
  open: ValOpen;
  setOpen: (v: ValOpen) => void;
}) {
  return (
    <div className={`vx-card vx-bars vx-bars--${side}`}>
      <span className="vx-label vx-label--title">{title}</span>
      {!rows.length ? <p className="vx-empty">No sectors.</p> : null}
      {rows.map((r) => {
        const pctv = side === "under" ? r.under_pct : r.over_pct;
        const k = side === "under" ? r.under : r.over;
        const on = open?.industry === r.industry && open.side === side;
        return (
          <button
            key={r.industry}
            type="button"
            className={`vx-bar-row${on ? " on" : ""}`}
            onClick={() => setOpen(on ? null : { industry: r.industry, side })}
            title={`${k} of ${r.scored} companies ${side === "under" ? "below" : "above"} their own 5-year median P/E — click for the list`}
          >
            <span className="vx-bar-name">{r.industry}</span>
            <span className="vx-bar-track">
              <span className="vx-bar-fill" style={{ width: `${pctv}%` }} />
            </span>
            <span className="vx-bar-pct">{pctv % 1 ? pctv.toFixed(1) : pctv}%</span>
            <span className="vx-bar-k">
              {k}/{r.scored}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ValuationView({ onOpen }: { onOpen: (industry: string) => void }) {
  const [data, setData] = useState<ValSector[] | null>(null);
  const [dist, setDist] = useState<ValDistribution | null>(null);
  const [segments, setSegments] = useState<ValMcapSegment[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [minN, setMinN] = useState(1);
  const [open, setOpen] = useState<ValOpen>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/value-tools?kind=valuation", { cache: "no-store" });
        const j = (await res.json()) as {
          ok?: boolean;
          error?: string;
          rows?: ValSector[];
          as_of?: string | null;
          distribution?: ValDistribution;
          mcap_segments?: ValMcapSegment[];
        };
        if (!live) return;
        if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
        setData(j.rows ?? []);
        setDist(j.distribution ?? null);
        setSegments(j.mcap_segments ?? null);
        setAsOf(j.as_of ?? null);
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const [picked, setPicked] = useState<string[]>([]);
  const eligible = useMemo(
    () => (data ?? []).filter((r) => r.scored >= minN && (!picked.length || picked.includes(r.industry))),
    [data, minN, picked],
  );
  const under = useMemo(() => {
    const rows = [...eligible]
      .filter((r) => r.under > 0)
      .sort((a, b) => b.under_pct - a.under_pct || b.scored - a.scored);
    return picked.length ? rows : rows.slice(0, 15);
  }, [eligible, picked.length]);
  const over = useMemo(() => {
    const rows = [...eligible]
      .filter((r) => r.over > 0)
      .sort((a, b) => b.over_pct - a.over_pct || b.scored - a.scored);
    return picked.length ? rows : rows.slice(0, 15);
  }, [eligible, picked.length]);
  const sel = open ? (data ?? []).find((r) => r.industry === open.industry) ?? null : null;

  return (
    <>
      <div className="vx-card vx-wind-bar">
        <label className="vx-field vx-field--inline">
          <span className="vx-label">Min companies with data</span>
          <select value={minN} onChange={(e) => setMinN(Number(e.target.value))}>
            {[1, 2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
          </select>
        </label>
        <MultiPick
          label="Industry"
          allLabel="All industries"
          values={picked}
          onChange={setPicked}
          options={(data ?? []).filter((r) => r.scored >= minN).map((r) => ({ id: r.industry, label: r.industry, count: r.scored })).sort((a, b) => a.label.localeCompare(b.label))}
          searchable
        />
        <HoldingsIndustryCheck
          values={picked}
          onChange={setPicked}
          available={(data ?? []).filter((r) => r.scored >= minN).map((r) => r.industry)}
        />
        <span className="vx-hint vx-push">
          Undervalued = today&apos;s P/E more than 15% below the company&apos;s own 5-year median P/E · overvalued = more than 15% above · extreme = 30%+
          {asOf ? ` · prices to ${asOf}` : ""}
        </span>
      </div>

      <ValuationGraphs dist={data ? dist : null} segments={data ? segments : null} />

      {err ? (
        <p className="vx-msg vx-msg--err">Could not load: {err}</p>
      ) : !data ? (
        <p className="vx-empty">Working out 5 years of P/E for every company…</p>
      ) : (
        <>
          <div className="vx-bars-grid">
            <Bars
              title={picked.length ? "Undervalued sectors" : "Top 15 undervalued sectors by %"}
              rows={under}
              side="under"
              open={open}
              setOpen={setOpen}
            />
            <Bars
              title={picked.length ? "Overvalued sectors" : "Top 15 overvalued sectors by %"}
              rows={over}
              side="over"
              open={open}
              setOpen={setOpen}
            />
          </div>
          {sel ? (
            <div className="vx-card vx-table-card">
              <div className="vx-table-head">
                <span className="vx-label vx-label--title">
                  {sel.industry} · {sel.scored} of {sel.n} companies have 5 years of P/E history
                </span>
                <button type="button" className="vx-btn" onClick={() => onOpen(sel.industry)}>
                  Rank this industry →
                </button>
              </div>
              <div className="vx-scroll">
                <table className="vx-table">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th className="num">P/E now</th>
                      <th className="num">5Y median P/E</th>
                      <th className="num">Now vs own history</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sel.stocks.map((s) => (
                      <tr key={s.t}>
                        <td>
                          <a className="vx-co" href={tradingviewUrl(s.t, "NSE")} target="_blank" rel="noopener noreferrer">
                            {s.name}
                          </a>
                          <span className="vx-sub">
                            {s.t}
                            <ReviewPlusButton ticker={s.t} />
                            <a className="np-chip" href={napkinUrl(s.t)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                              NP
                            </a>
                          </span>
                        </td>
                        <td className="num">{s.pe.toFixed(1)}</td>
                        <td className="num">{s.peMedian.toFixed(1)}</td>
                        <td className={`num ${s.ratio < 1 ? "pos-t" : "neg"}`}>
                          {s.ratio >= 1 ? "+" : ""}
                          {Math.round((s.ratio - 1) * 100)}%
                        </td>
                        <td>
                          <span className={`vx-val vx-val--${s.verdict}`}>
                            {s.verdict === "under" ? "Undervalued" : s.verdict === "over" ? "Overvalued" : "Fair"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="vx-hint">Click a sector to see its companies.</p>
          )}
        </>
      )}
    </>
  );
}

// ---- Earnings Trends (quarterly Revenue vs Earnings) ------------------------------------

function EarningsTrendsView({ universe }: { universe: Stock[] | null }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Stock | null>(null);
  const [panel, setPanel] = useState<QuarterPanel | null>(null);
  const [yoy, setYoy] = useState<{ sales_yoy: number | null; np_yoy: number | null; ebidt_yoy: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !universe) return [];
    return universe
      .filter((r) => r.t.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [q, universe]);

  useEffect(() => {
    if (!picked) {
      setPanel(null);
      setYoy(null);
      setErr(null);
      return;
    }
    let live = true;
    setBusy(true);
    setErr(null);
    void (async () => {
      try {
        const sp = new URLSearchParams({ ticker: picked.t });
        if (picked.market) sp.set("market", picked.market);
        const res = await fetch(`/api/quarters?${sp}`, { cache: "no-store" });
        const j = (await res.json()) as {
          ok?: boolean;
          error?: string;
          quarters?: QuarterPanel | null;
          yoy?: { sales_yoy: number | null; np_yoy: number | null; ebidt_yoy: number | null };
        };
        if (!live) return;
        if (!res.ok || j.ok === false || !j.quarters) throw new Error(j.error || "No quarterly data");
        setPanel(j.quarters);
        setYoy(j.yoy ?? null);
      } catch (e) {
        if (live) {
          setPanel(null);
          setYoy(null);
          setErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [picked]);

  return (
    <>
      <p className="vx-hint" style={{ marginBottom: 12 }}>
        Search any Indian stock to pull its historical Revenue vs. Earnings chart · quarterly
      </p>
      <div className="vx-earn">
        <aside className="vx-card vx-earn-side">
          <span className="vx-label vx-label--title">Search Stock</span>
          <input
            className="vx-earn-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ticker or name"
            aria-label="Search stock"
          />
          {!universe ? <p className="vx-empty">Loading universe…</p> : null}
          {q.trim() && !hits.length ? <p className="vx-empty">No matches.</p> : null}
          <ul className="vx-earn-hits">
            {hits.map((h) => (
              <li key={h.t}>
                <button
                  type="button"
                  className={`vx-earn-hit${picked?.t === h.t ? " on" : ""}`}
                  onClick={() => {
                    setPicked(h);
                    setQ(h.t);
                  }}
                >
                  <strong>{h.t}</strong>
                  <span>{h.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="vx-card vx-earn-main">
          {!picked ? (
            <p className="vx-empty">Pick a stock to see quarterly Revenue vs Earnings.</p>
          ) : (
            <RevenueEarningsChart
              panel={panel}
              yoy={yoy}
              name={picked.name}
              ticker={picked.t}
              market={picked.market}
              loading={busy}
              error={err}
            />
          )}
        </div>
      </div>
    </>
  );
}
