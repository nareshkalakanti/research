"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NanoFillJob } from "@/lib/nanocap-champs";
import type { ScreenerLeafRow, ScreenerTickerRow } from "@/lib/screener-industries";

type Status = {
  mapped: number;
  companies_total: number;
  leaves: number;
  done_leaves: number;
  active: boolean;
  last: string | null;
  paused_until: string | null;
};

type Conn = {
  login?: boolean;
  screener_paused_until?: string | null;
  pages_left_this_hour?: number | null;
};

type BrowseTab = "leaves" | "tickers";

function fmtIn(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return Math.round(n).toLocaleString("en-IN");
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return `${Math.round(n)}%`;
}

/**
 * Data → Screener.in: industry tree sync + login / rate-limit status + browse.
 * Investor fund pages stay on Watchlist (they refresh daily on their own).
 */
export function ScreenerInPanel() {
  const [st, setSt] = useState<Status | null>(null);
  const [job, setJob] = useState<NanoFillJob | null>(null);
  const [conn, setConn] = useState<Conn | null>(null);
  const [browse, setBrowse] = useState<BrowseTab>("leaves");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [leaves, setLeaves] = useState<ScreenerLeafRow[] | null>(null);
  const [tickers, setTickers] = useState<ScreenerTickerRow[] | null>(null);
  const [tickerTotal, setTickerTotal] = useState(0);
  const [pathFilter, setPathFilter] = useState<string | null>(null);
  const [browseErr, setBrowseErr] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  /** null = Screener S.No. order; asc/desc = Median 1Y Return. */
  const [retSort, setRetSort] = useState<"asc" | "desc" | null>(null);

  const load = useCallback(async () => {
    const indP = fetch("/api/screener-industries", { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null);
    const valueP = fetch("/api/value-tools?kind=auto", { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null);
    const [ind, value] = await Promise.all([indP, valueP]);
    if ((ind as { ok?: boolean } | null)?.ok) {
      setSt((ind as { status: Status }).status);
      setJob((ind as { job: NanoFillJob | null }).job);
    }
    setConn({
      login: !!(ind as { login?: boolean } | null)?.login,
      screener_paused_until:
        (value as { screener_paused_until?: string | null } | null)?.screener_paused_until ??
        (ind as { status?: Status } | null)?.status?.paused_until ??
        null,
      pages_left_this_hour:
        (value as { pages_left_this_hour?: number | null } | null)?.pages_left_this_hour ?? null,
    });
    return (ind as { job?: NanoFillJob | null } | null)?.job ?? null;
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    const onRefresh = () => void load();
    window.addEventListener("app:refresh", onRefresh);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("app:refresh", onRefresh);
    };
  }, [load]);

  const running = !!(job?.running && job.kind === "screener-ind");
  const pending = !!(st?.active && (st.leaves === 0 || st.done_leaves < st.leaves));
  useEffect(() => {
    if (!running && !pending) return;
    const id = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(id);
  }, [running, pending, load]);

  useEffect(() => {
    const t = window.setTimeout(() => setQDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const loadBrowse = useCallback(async () => {
    setBrowseLoading(true);
    setBrowseErr(null);
    try {
      if (browse === "leaves") {
        const sp = new URLSearchParams({ view: "leaves" });
        if (qDebounced) sp.set("q", qDebounced);
        const j = (await (await fetch(`/api/screener-industries?${sp}`, { cache: "no-store" })).json()) as {
          ok?: boolean;
          error?: string;
          leaves?: ScreenerLeafRow[];
        };
        if (!j.ok) throw new Error(j.error || "Could not load leaves");
        setLeaves(j.leaves ?? []);
      } else {
        const sp = new URLSearchParams({ view: "tickers", limit: "10000" });
        if (qDebounced) sp.set("q", qDebounced);
        if (pathFilter) sp.set("path", pathFilter);
        const j = (await (await fetch(`/api/screener-industries?${sp}`, { cache: "no-store" })).json()) as {
          ok?: boolean;
          error?: string;
          rows?: ScreenerTickerRow[];
          total?: number;
        };
        if (!j.ok) throw new Error(j.error || "Could not load tickers");
        setTickers(j.rows ?? []);
        setTickerTotal(j.total ?? 0);
      }
    } catch (e) {
      setBrowseErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowseLoading(false);
    }
  }, [browse, qDebounced, pathFilter]);

  useEffect(() => {
    void loadBrowse();
  }, [loadBrowse]);

  // After a sync finishes, refresh the table.
  useEffect(() => {
    if (running) return;
    void loadBrowse();
  }, [running, loadBrowse]);

  const post = async (body: object) => {
    const json = (await (
      await fetch("/api/screener-industries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json()) as { job: NanoFillJob | null };
    setJob(json.job);
  };

  const paused = conn?.screener_paused_until
    ? new Date(conn.screener_paused_until).toLocaleString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "numeric",
        month: "short",
      })
    : null;

  const openLeafTickers = (leaf: ScreenerLeafRow) => {
    setPathFilter(leaf.market_path);
    setBrowse("tickers");
    setQ("");
  };

  const refreshOverview = async () => {
    setBrowseLoading(true);
    setBrowseErr(null);
    try {
      const j = (await (
        await fetch("/api/screener-industries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overview: true }),
        })
      ).json()) as { ok?: boolean; error?: string };
      if (!j.ok) throw new Error(j.error || "Overview refresh failed");
      await loadBrowse();
    } catch (e) {
      setBrowseErr(e instanceof Error ? e.message : String(e));
      setBrowseLoading(false);
    }
  };

  const sortedLeaves = useMemo(() => {
    const rows = leaves ?? [];
    if (!retSort) return rows;
    const dir = retSort === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a.median_1y_return;
      const bv = b.median_1y_return;
      const aOk = av != null && Number.isFinite(av);
      const bOk = bv != null && Number.isFinite(bv);
      if (!aOk && !bOk) return (a.list_order ?? 0) - (b.list_order ?? 0);
      if (!aOk) return 1;
      if (!bOk) return -1;
      if (av !== bv) return (av! - bv!) * dir;
      return (a.list_order ?? 0) - (b.list_order ?? 0);
    });
  }, [leaves, retSort]);

  const totalStocks = useMemo(
    () => sortedLeaves.reduce((s, r) => s + (r.companies ?? r.ticker_count ?? 0), 0),
    [sortedLeaves],
  );

  const toggleRetSort = () => {
    setRetSort((cur) => (cur === null ? "desc" : cur === "desc" ? "asc" : null));
  };

  return (
    <section className="nano-section sc-panel">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">Industry tree from screener.in</span>
          <h2 className="vx-title">
            Screener<span>.in</span>
          </h2>
          <p className="vx-hint mcs-lede">
            Sync sector / industry / sub_sector from Screener&apos;s market tree (duplicate crumbs collapsed). Stored in{" "}
            <code>data/screener_industries.db</code> — browse leaves and tickers below. Crawl runs on the server — you can
            leave this tab; keep the app open so it can resume.
          </p>
        </div>
      </header>

      <div className="sc-card">
        <div className="sc-card-head">
          <strong>Connection</strong>
          <span className="sl-sub">
            {conn == null
              ? "Checking…"
              : conn.login
                ? "Logged in (SCREENER_SESSIONID set)"
                : "Not logged in — set SCREENER_SESSIONID in .env.local (optional for public market pages)"}
            {paused ? ` · paused until ${paused}` : ""}
            {conn?.pages_left_this_hour != null
              ? ` · ${conn.pages_left_this_hour.toLocaleString("en-IN")} pages left this hour`
              : ""}
          </span>
          <span className="fb-spacer" />
          <a className="btn-ghost" href="https://www.screener.in/market/" target="_blank" rel="noopener noreferrer">
            Open industries
          </a>
        </div>
        {conn && !conn.login ? (
          <p className="sm-warn">
            Log in at screener.in, then copy the <code>sessionid</code> cookie (DevTools → Application → Cookies →
            screener.in) into <code>.env.local</code> as <code>SCREENER_SESSIONID=…</code> and reload.
          </p>
        ) : null}
      </div>

      <div className="sl-status ss-bar" role="status" aria-live="polite">
        <span>
          <strong>Industry tree:</strong>{" "}
          {st
            ? st.leaves > 0
              ? `${st.leaves.toLocaleString("en-IN")} industries · ${(st.companies_total || 0).toLocaleString("en-IN")} stocks · ${st.mapped.toLocaleString("en-IN")} mapped`
              : `${st.mapped.toLocaleString("en-IN")} tickers labeled`
            : "…"}
          <span className="sl-sub-inline">
            {running
              ? ` · live ${job!.done.toLocaleString("en-IN")} / ${(job!.total || 0).toLocaleString("en-IN")} · ${job!.filled.toLocaleString("en-IN")} writes`
              : pending
                ? " · incomplete — will resume"
                : st?.last
                  ? ` · last sync ${new Date(st.last).toLocaleString("en-IN")}`
                  : " · not synced yet"}
            {job?.error && job.kind === "screener-ind" ? ` · ${job.error}` : ""}
          </span>
        </span>
        {running ? (
          <span className="sl-fill">
            <span className="ld-spin" aria-hidden /> Syncing leaf {job!.done.toLocaleString("en-IN")} of{" "}
            {(job!.total || 0).toLocaleString("en-IN")} · {job!.filled.toLocaleString("en-IN")} ticker writes
            <button type="button" className="btn-ghost" onClick={() => void post({ stop: true })}>
              Stop
            </button>
          </span>
        ) : (
          <span className="sl-fill">
            <button
              type="button"
              className="btn-ghost"
              disabled={!!job?.running}
              onClick={() => void post({})}
              title="Walk ~190 Screener leaf industries on the server (resumes if interrupted). Leave this tab if you want — keep the app running."
            >
              {pending ? "Resume industries from Screener" : st?.mapped ? "Refresh industries from Screener" : "Get industries from Screener"}
            </button>
          </span>
        )}
      </div>

      <div className="sc-card sc-browse">
        <div className="sc-card-head">
          <strong>View data</strong>
          <div className="mcs-seg" role="group" aria-label="Browse leaves or tickers">
            <button
              type="button"
              className={browse === "leaves" ? "on" : ""}
              aria-pressed={browse === "leaves"}
              onClick={() => {
                setBrowse("leaves");
                setPathFilter(null);
              }}
            >
              Leaves
            </button>
            <button
              type="button"
              className={browse === "tickers" ? "on" : ""}
              aria-pressed={browse === "tickers"}
              onClick={() => setBrowse("tickers")}
            >
              Tickers
            </button>
          </div>
          <input
            className="fb-search sc-browse-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={browse === "leaves" ? "Filter industries…" : "Filter tickers, sector, industry…"}
            aria-label="Filter table"
          />
          {browse === "leaves" ? (
            <>
              <button
                type="button"
                className="btn-ghost"
                disabled={browseLoading || !!job?.running}
                onClick={() => void refreshOverview()}
                title="Pull Industries Overview ratios from screener.in/market (one page)"
              >
                Refresh overview
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={browseLoading || !!job?.running}
                onClick={() => void post({ counts: true })}
                title="Pull each leaf’s full result count (includes SME / BSE). Does not remap tickers."
              >
                Refresh counts (incl. SME)
              </button>
            </>
          ) : null}
          {pathFilter ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setPathFilter(null)}
              title="Clear leaf filter"
            >
              Clear leaf filter
            </button>
          ) : null}
          <span className="fb-spacer" />
          <span className="sl-sub sc-browse-counts" aria-live="polite">
            {browseLoading
              ? "Loading…"
              : browse === "leaves"
                ? `${sortedLeaves.length.toLocaleString("en-IN")} industries · ${totalStocks.toLocaleString("en-IN")} stocks (final)`
                : `${tickerTotal.toLocaleString("en-IN")} tickers${
                    pathFilter ? "" : st?.companies_total ? ` · ${st.companies_total.toLocaleString("en-IN")} on Screener leaves` : ""
                  }`}
            {pathFilter ? " · one leaf" : ""}
          </span>
        </div>
        {browseErr ? <p className="sm-warn">{browseErr}</p> : null}
        <div className="table-wrap nano-wrap sc-browse-scroll">
          {browse === "leaves" ? (
            !leaves?.length && !browseLoading ? (
              <p className="vx-empty">No overview yet — Refresh overview or run a sync above.</p>
            ) : (
              <table className="data-table nano-table sc-table sc-overview-table">
                <thead>
                  <tr>
                    <th className="num">S.No.</th>
                    <th className="nano-col-name">Industry</th>
                    <th className="num">No. of Companies</th>
                    <th className="num">Total Market Cap.</th>
                    <th className="num">Median Market Cap.</th>
                    <th className="num">Median P/E</th>
                    <th className="num">Sales Growth</th>
                    <th className="num">OPM</th>
                    <th className="num">Wtd. Avg ROCE</th>
                    <th className="num">
                      <button
                        type="button"
                        className="sc-sort"
                        onClick={toggleRetSort}
                        title="Sort by Median 1Y Return"
                      >
                        Median 1Y Return
                        {retSort === "desc" ? " ↓" : retSort === "asc" ? " ↑" : ""}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedLeaves.map((r, i) => {
                    const sno = retSort ? i + 1 : (r.list_order ?? i + 1);
                    const companies = r.companies ?? r.ticker_count;
                    return (
                      <tr key={r.market_path}>
                        <td className="num">{sno}.</td>
                        <td className="nano-col-name">
                          <button
                            type="button"
                            className="nano-name link-btn"
                            onClick={() => openLeafTickers(r)}
                            title="Show tickers in this industry"
                          >
                            {r.title || r.sub_sector || r.market_path}
                          </button>
                        </td>
                        <td className="num">{fmtIn(companies)}</td>
                        <td className="num">{fmtIn(r.total_mcap)}</td>
                        <td className="num">{fmtIn(r.median_mcap)}</td>
                        <td className="num">{fmtNum(r.median_pe)}</td>
                        <td className="num">{fmtPct(r.sales_growth)}</td>
                        <td className="num">{fmtPct(r.opm)}</td>
                        <td className="num">{fmtPct(r.wtd_avg_roce)}</td>
                        <td className="num">{fmtPct(r.median_1y_return)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          ) : !tickers?.length && !browseLoading ? (
            <p className="vx-empty">No tickers match.</p>
          ) : (
            <table className="data-table nano-table sc-table">
              <thead>
                <tr>
                  <th className="num">S.No.</th>
                  <th>Ticker</th>
                  <th>Sector</th>
                  <th>Industry</th>
                  <th>Sub-sector</th>
                </tr>
              </thead>
              <tbody>
                {(tickers ?? []).map((r, i) => (
                  <tr key={`${r.ticker}:${r.market_path}`}>
                    <td className="num">{i + 1}</td>
                    <td className="nano-col-name">
                      <strong className="nano-name">{r.ticker}</strong>
                    </td>
                    <td className="sc-ind">{r.sector}</td>
                    <td className="sc-ind">{r.industry}</td>
                    <td className="sc-ind">{r.sub_sector}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="table-meta">
          Same columns/order as{" "}
          <a href="https://www.screener.in/market/" target="_blank" rel="noopener noreferrer">
            screener.in/market
          </a>
          {browse === "leaves"
            ? " · No. of Companies uses each leaf’s full result count (includes SME / BSE when Screener lists them; overview ratios may still be main-board weighted)"
            : ""}{" "}
          · <code>data/screener_industries.db</code>
          {browse === "leaves" && totalStocks > 0
            ? ` · final count ${totalStocks.toLocaleString("en-IN")} stocks`
            : ""}
          {browse === "tickers" && tickerTotal > 0
            ? ` · ${tickerTotal.toLocaleString("en-IN")} mapped tickers`
            : ""}
        </p>
      </div>
    </section>
  );
}
