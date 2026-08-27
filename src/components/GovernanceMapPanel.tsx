"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CapMarketFilters,
  type CapFilter,
} from "@/components/CapMarketFilters";
import { GovernanceScanBar } from "@/components/GovernanceScanBar";
import { GovernanceChangesPanel } from "@/components/GovernanceChangesPanel";
import { HighlightedText } from "@/components/HighlightedText";
import { FundWatchlistTags } from "@/components/FundWatchlistTags";
import {
  appendFundParams,
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  type FundFilterState,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";
import {
  BRIDGE_TI_MAX_CR,
  BRIDGE_TINY_MAX_CR,
  GOV_CAP_BRIDGE_LABEL,
  GOV_CAP_BRIDGE_TITLE,
  GOV_MIC_BRIDGE_LABEL,
  GOV_MIC_BRIDGE_TITLE,
  GOV_TI_BRIDGE_LABEL,
  GOV_TI_BRIDGE_TITLE,
  GOV_MULTI_LC_LABEL,
  GOV_MULTI_LC_TITLE,
  GOV_SME_CROSS_TITLE,
} from "@/lib/gov-score";
import { formatMcap } from "@/lib/types";

type View = "director" | "company";
type BridgeMode = "off" | "ti" | "mic" | "cap";

type Stats = {
  directors: number;
  din_backed: number;
  name_only: number;
  bridges: number;
  tiny_bridges: number;
  ti_bridges: number;
  multi_lc: number;
  sme_cross: number;
  companies: number;
};

type Seat = {
  ticker: string;
  name: string;
  market: string;
  designation: string;
  category: string | null;
  market_cap_cr: number | null;
  cap_code: string | null;
  about: string | null;
  headquarters?: string | null;
  sector: string | null;
  is_sme: boolean;
  has_bb: boolean;
  has_tq: boolean;
  has_hold?: boolean;
  has_edge?: boolean;
  fund_tags?: FundWatchlistKey[];
  fund_changes?: Partial<
    Record<FundWatchlistKey, import("@/lib/fund-watchlist-meta").FundChangeInfo>
  >;
  web: string | null;
  sc: string;
  tv: string;
};

type ScoreBreakdown = {
  board_count: number;
  big_n: number;
  small_n: number;
  tiny_n?: number;
  bridge?: boolean;
  tiny_bridge?: boolean;
  ti_bridge?: boolean;
  multi_lc?: boolean;
  lc_n?: number;
  bonus: number;
  overload_penalty: number;
};

type DirectorRow = {
  person_id: string;
  din: string | null;
  name: string;
  board_count: number;
  dir_score: number;
  din_backed: boolean;
  name_collision: boolean;
  bridge: boolean;
  tiny_bridge?: boolean;
  ti_bridge?: boolean;
  multi_lc?: boolean;
  lc_n?: number;
  sme_cross?: boolean;
  score_breakdown?: ScoreBreakdown;
  companies: Seat[];
};

type CompanyRow = {
  ticker: string;
  name: string;
  market: string;
  market_cap_cr: number | null;
  cap_code: string | null;
  has_bb: boolean;
  has_tq: boolean;
  has_hold?: boolean;
  has_edge?: boolean;
  fund_tags?: FundWatchlistKey[];
  fund_changes?: Partial<
    Record<FundWatchlistKey, import("@/lib/fund-watchlist-meta").FundChangeInfo>
  >;
  about?: string | null;
  headquarters?: string | null;
  sc: string;
  tv: string;
  web: string | null;
  directors: Array<{
    person_id: string;
    name: string;
    din: string | null;
    dir_score: number;
    din_backed: boolean;
    designation: string;
    category: string | null;
  }>;
};

type ApiResponse = {
  view: View;
  stats: Stats;
  total: number;
  page: number;
  pages: number;
  rows: DirectorRow[] | CompanyRow[];
};

function GovAbout({
  about,
  headquarters,
}: {
  about: string;
  headquarters?: string | null;
}) {
  const [more, setMore] = useState(false);
  const text = about.trim();
  if (!text && !headquarters) return null;
  const short = text.length > 320 && !more;
  const display = short ? `${text.slice(0, 320).trim()}…` : text;

  return (
    <div className="gov-about">
      {headquarters ? (
        <div className="gov-hq">
          <span className="gov-hq-label">HQ</span>
          <HighlightedText text={headquarters} keywords={[]} />
        </div>
      ) : null}
      {text ? (
        <p>
          <HighlightedText text={display} keywords={[]} />
        </p>
      ) : null}
      {text.length > 320 ? (
        <button
          type="button"
          className="show-more"
          onClick={() => setMore((m) => !m)}
        >
          {more ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

const EMPTY_FUNDS = Object.fromEntries(
  FUND_WATCHLIST_KEYS.map((k) => [k, false]),
) as FundFilterState;

export function GovernanceMapPanel() {
  const [view, setView] = useState<View>("director");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [minBoards, setMinBoards] = useState(2);
  const [bridgeMode, setBridgeMode] = useState<BridgeMode>("off");
  const [filterMultiLc, setFilterMultiLc] = useState(false);
  const [filterHold, setFilterHold] = useState(false);
  const [filterEdge, setFilterEdge] = useState(false);
  const [fundFilters, setFundFilters] = useState<FundFilterState>(EMPTY_FUNDS);
  const [cap, setCap] = useState<CapFilter>("All");
  const [sme, setSme] = useState(false);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [changesRefreshKey, setChangesRefreshKey] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setPage(1);
    setOpenId(null);
  }, [view, debouncedQ, minBoards, bridgeMode, filterMultiLc, filterHold, filterEdge, fundFilters, cap, sme]);

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      setLoading(true);
      const params = new URLSearchParams({
        view,
        q: debouncedQ,
        page: String(page),
        pageSize: "40",
        minScore: "0",
        minBoards: String(minBoards),
        sort: "score",
        dinOnly: "1",
      });
      if (bridgeMode === "ti") params.set("tiBridge", "1");
      if (bridgeMode === "mic") params.set("tinyBridge", "1");
      if (bridgeMode === "cap") params.set("bridge", "1");
      if (filterMultiLc) params.set("multiLc", "1");
      if (filterHold) params.set("hold", "1");
      if (filterEdge) params.set("edge", "1");
      appendFundParams(params, fundFilters);
      if (cap !== "All") params.set("cap", cap);
      if (sme) params.set("sme", "1");
      if (opts?.refresh) params.set("refresh", "1");
      try {
        const res = await fetch(`/api/governance-map?${params}`);
        const text = await res.text();
        let json: ApiResponse & { error?: string };
        try {
          json = JSON.parse(text) as ApiResponse & { error?: string };
        } catch {
          setLoadError(
            res.ok
              ? "Invalid response from governance map"
              : `Governance map failed (${res.status})`,
          );
          setData(null);
          return;
        }
        if (!res.ok || json.error) {
          setLoadError(json.error || `Governance map failed (${res.status})`);
          setData(null);
          return;
        }
        setLoadError(null);
        setData(json);
      } catch (err) {
        setLoadError(
          err instanceof Error ? err.message : "Governance map request failed",
        );
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [view, debouncedQ, page, minBoards, bridgeMode, filterMultiLc, filterHold, filterEdge, fundFilters, cap, sme],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const stats = data?.stats;
  const start = data ? (data.page - 1) * 40 + 1 : 0;
  const end = data ? Math.min(data.page * 40, data.total) : 0;
  const ready = data?.view === view;
  const directorRows =
    ready && view === "director" ? (data.rows as DirectorRow[]) : [];
  const companyRows =
    ready && view === "company" ? (data.rows as CompanyRow[]) : [];

  const pageTickers = useMemo(() => {
    const set = new Set<string>();
    if (view === "director") {
      for (const r of directorRows) {
        for (const c of r.companies ?? []) {
          if (c.ticker) set.add(c.ticker.toUpperCase());
        }
      }
    } else {
      for (const c of companyRows) {
        if (c.ticker) set.add(c.ticker.toUpperCase());
      }
    }
    return [...set];
  }, [view, directorRows, companyRows]);

  function drillDirector(personId: string, name: string) {
    setQ(name);
    setDebouncedQ(name);
    setView("director");
    setOpenId(personId);
  }

  function bumpChanges() {
    setChangesRefreshKey((k) => k + 1);
  }

  function drillTicker(ticker: string) {
    setQ(ticker);
    setDebouncedQ(ticker);
    setView("director");
    setOpenId(null);
  }

  function toggleBridge(mode: BridgeMode) {
    setBridgeMode((cur) => (cur === mode ? "off" : mode));
  }

  function onCapChange(next: CapFilter) {
    setCap(next);
    // Cap band filter is independent of bridge size; clear bridge so MIC/SC aren't empty.
    if (next !== "All") setBridgeMode("off");
  }

  const bridgeHint = filterMultiLc
    ? "2+ large-cap boards (≥ ₹20,000 Cr) — group chairs, cross-holdings"
    : bridgeMode === "ti"
      ? `≥ ₹5,000 Cr board + under ₹${BRIDGE_TI_MAX_CR} Cr`
      : bridgeMode === "mic"
        ? `≥ ₹5,000 Cr board + under ₹${BRIDGE_TINY_MAX_CR} Cr`
        : bridgeMode === "cap"
          ? "≥ ₹5,000 Cr board + under ₹5,000 Cr"
          : "Pick a size filter to find big-board directors on small names";

  const filtersActive =
    q.trim().length > 0 ||
    minBoards !== 2 ||
    bridgeMode !== "off" ||
    filterMultiLc ||
    filterHold ||
    filterEdge ||
    FUND_WATCHLIST_KEYS.some((k) => fundFilters[k]) ||
    cap !== "All" ||
    sme;

  function clearFilters() {
    setQ("");
    setDebouncedQ("");
    setMinBoards(2);
    setBridgeMode("off");
    setFilterMultiLc(false);
    setFilterHold(false);
    setFilterEdge(false);
    setFundFilters(EMPTY_FUNDS);
    setCap("All");
    setSme(false);
    setOpenId(null);
  }

  return (
    <div className="panel">
      <div className="toolbar gov-toolbar">
        <div className="gov-view-tabs" role="tablist" aria-label="Map view">
          {(
            [
              ["director", "Directors"],
              ["company", "Companies"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={view === id ? "tab on" : "tab"}
              aria-selected={view === id}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="field grow">
          <span>Search</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Director, DIN, company, ticker…"
            aria-label="Search directors and companies"
          />
        </label>

        <label className="field">
          <span>Boards</span>
          <select
            value={minBoards}
            onChange={(e) => setMinBoards(Number(e.target.value))}
          >
            <option value={2}>2+</option>
            <option value={3}>3+</option>
            <option value={4}>4+</option>
            <option value={5}>5+</option>
          </select>
        </label>

        <button
          type="button"
          className="btn-ghost"
          disabled={loading}
          onClick={() => load({ refresh: true })}
        >
          {loading ? "…" : "Refresh"}
        </button>
        <GovernanceScanBar
          variant="inline"
          market="All"
          pageTickers={pageTickers}
          onDone={async () => {
            bumpChanges();
            await load({ refresh: true });
          }}
        />
      </div>

      <div className="gov-focus-bar">
        <span className="gov-focus-label">Large side</span>
        <div className="gov-focus-seg" role="group" aria-label="Multi large-cap directors">
          <button
            type="button"
            className={filterMultiLc ? "on" : undefined}
            onClick={() => setFilterMultiLc((v) => !v)}
            title={GOV_MULTI_LC_TITLE}
          >
            {GOV_MULTI_LC_LABEL}
            {stats?.multi_lc != null ? <i>{stats.multi_lc}</i> : null}
          </button>
        </div>
        <span className="gov-focus-label">Small side</span>
        <div className="gov-focus-seg" role="group" aria-label="Small company size">
          <button
            type="button"
            className={bridgeMode === "ti" ? "on" : undefined}
            onClick={() => toggleBridge("ti")}
            title={GOV_TI_BRIDGE_TITLE}
          >
            {GOV_TI_BRIDGE_LABEL}
            {stats?.ti_bridges != null ? <i>{stats.ti_bridges}</i> : null}
          </button>
          <button
            type="button"
            className={bridgeMode === "mic" ? "on" : undefined}
            onClick={() => toggleBridge("mic")}
            title={GOV_MIC_BRIDGE_TITLE}
          >
            {GOV_MIC_BRIDGE_LABEL}
            {stats?.tiny_bridges != null ? <i>{stats.tiny_bridges}</i> : null}
          </button>
          <button
            type="button"
            className={bridgeMode === "cap" ? "on" : undefined}
            onClick={() => toggleBridge("cap")}
            title={GOV_CAP_BRIDGE_TITLE}
          >
            {GOV_CAP_BRIDGE_LABEL}
            {stats?.bridges != null ? <i>{stats.bridges}</i> : null}
          </button>
        </div>
        <div className="gov-focus-seg gov-focus-watch" role="group" aria-label="Watchlists">
          <button
            type="button"
            className={`hold ${filterHold ? "on" : ""}`}
            onClick={() => setFilterHold((v) => !v)}
            title="Any board seat is in your HOLD list"
          >
            Hold
          </button>
          <button
            type="button"
            className={`edge ${filterEdge ? "on" : ""}`}
            onClick={() => setFilterEdge((v) => !v)}
            title="Any board seat is on Early Edge"
          >
            Edge
          </button>
          {FUND_WATCHLIST_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={`${key} ${fundFilters[key] ? "on" : ""}`}
              onClick={() =>
                setFundFilters((prev) => ({ ...prev, [key]: !prev[key] }))
              }
              title={`Any board seat is on ${FUND_WATCHLIST_LABELS[key]}`}
            >
              {FUND_WATCHLIST_LABELS[key]}
            </button>
          ))}
        </div>
        <p className="gov-focus-hint">{bridgeHint}</p>
      </div>

      <div className="gov-cap-filters">
        <CapMarketFilters
          cap={cap}
          onCap={onCapChange}
          sme={sme}
          onSme={setSme}
          showSme
        />
        {filtersActive ? (
          <button
            type="button"
            className="clear-filter"
            onClick={clearFilters}
            title="Reset search and filters"
          >
            Clear
          </button>
        ) : null}
      </div>

      <GovernanceChangesPanel
        refreshKey={changesRefreshKey}
        onDrillDirector={drillDirector}
        onDrillTicker={drillTicker}
      />

      {stats ? (
        <div className="gov-stats">
          <span>
            <strong>{stats.directors.toLocaleString()}</strong> multi-board
          </span>
          <span>
            <strong>{stats.companies.toLocaleString()}</strong> companies
          </span>
          <span>
            <strong>{(stats.multi_lc ?? 0).toLocaleString()}</strong> multi-LC
          </span>
          <span>
            <strong>{(stats.ti_bridges ?? 0).toLocaleString()}</strong> &lt;₹100
          </span>
          <span>
            <strong>{stats.tiny_bridges.toLocaleString()}</strong> &lt;₹500
          </span>
          <span>
            <strong>{stats.bridges.toLocaleString()}</strong> cap bridges
          </span>
          <span>
            <strong>{stats.din_backed.toLocaleString()}</strong> DIN-linked
          </span>
        </div>
      ) : null}

      <div className="table-meta">
        {loading && !data ? (
          <span>Loading governance map…</span>
        ) : loadError ? (
          <span className="gov-load-error" role="alert">
            {loadError}
          </span>
        ) : data ? (
          <span>
            Showing {start.toLocaleString()}–{end.toLocaleString()} of{" "}
            {data.total.toLocaleString()}
          </span>
        ) : null}
      </div>

      {!ready && loading ? (
        <div className="table-meta">Loading…</div>
      ) : null}

      {view === "director" && ready ? (
        <div className="gov-list">
          {directorRows.map((r) => {
            const open = openId === r.person_id;
            const companies = r.companies ?? [];
            return (
              <article key={r.person_id} className="gov-card">
                <div
                  className="gov-card-head"
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpenId(open ? null : r.person_id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpenId(open ? null : r.person_id);
                    }
                  }}
                >
                  <div className="gov-dir">
                    <div className="gov-dir-name">
                      {r.name}
                      {r.din_backed ? (
                        <span className="gov-badge">DIN</span>
                      ) : (
                        <span className="gov-badge name">name</span>
                      )}
                      {r.ti_bridge ? (
                        <span
                          className="gov-badge tiny-bridge"
                          title={GOV_TI_BRIDGE_TITLE}
                        >
                          &lt;₹100
                        </span>
                      ) : r.tiny_bridge ? (
                        <span
                          className="gov-badge tiny-bridge"
                          title={GOV_MIC_BRIDGE_TITLE}
                        >
                          &lt;₹500
                        </span>
                      ) : r.multi_lc ? (
                        <span
                          className="gov-badge multi-lc"
                          title={GOV_MULTI_LC_TITLE}
                        >
                          {GOV_MULTI_LC_LABEL}
                          {r.lc_n != null && r.lc_n > 0 ? ` · ${r.lc_n}` : ""}
                        </span>
                      ) : r.bridge ? (
                        <span
                          className="gov-badge bridge"
                          title={GOV_CAP_BRIDGE_TITLE}
                        >
                          cap bridge
                        </span>
                      ) : null}
                      {r.sme_cross ? (
                        <span
                          className="gov-badge cross"
                          title={GOV_SME_CROSS_TITLE}
                        >
                          SME↔main
                        </span>
                      ) : null}
                    </div>
                    <div className="gov-dir-sub">
                      {r.din ? (
                        <>
                          <span>DIN {r.din}</span>
                          <span className="gov-sep">·</span>
                        </>
                      ) : null}
                      <span>{r.board_count} boards</span>
                      {companies.length ? (
                        <>
                          <span className="gov-sep">·</span>
                          <span className="gov-tickers">
                            {companies.map((c, i) => (
                              <button
                                key={c.ticker}
                                type="button"
                                className="gov-ticker"
                                title={`Show directors on ${c.ticker}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  drillTicker(c.ticker);
                                }}
                              >
                                {i > 0 ? ", " : null}
                                {c.ticker}
                              </button>
                            ))}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="gov-score" title="Director network score">
                    {r.dir_score.toFixed(1)}
                  </div>
                </div>
                {open ? (
                  <div className="gov-cos">
                    {r.score_breakdown ? (
                      <div className="gov-score-detail">
                        Score from {r.score_breakdown.board_count} boards
                        {r.score_breakdown.big_n > 0
                          ? ` · ${r.score_breakdown.big_n} mid/large`
                          : ""}
                        {r.score_breakdown.small_n > 0
                          ? ` · ${r.score_breakdown.small_n} sub-mid`
                          : ""}
                        {r.score_breakdown.lc_n > 0
                          ? ` · ${r.score_breakdown.lc_n} LC`
                          : ""}
                        {r.score_breakdown.ti_bridge
                          ? " · big→TI"
                          : r.score_breakdown.tiny_bridge
                            ? " · big→micro"
                            : r.score_breakdown.bridge
                              ? " · cap bridge"
                              : ""}
                        {r.score_breakdown.overload_penalty > 0
                          ? ` · −${r.score_breakdown.overload_penalty} overload`
                          : ""}
                      </div>
                    ) : null}
                    {companies.map((c) => {
                      const isTi =
                        c.market_cap_cr != null &&
                        c.market_cap_cr > 0 &&
                        c.market_cap_cr < BRIDGE_TI_MAX_CR;
                      const isTiny =
                        !isTi &&
                        c.market_cap_cr != null &&
                        c.market_cap_cr > 0 &&
                        c.market_cap_cr < BRIDGE_TINY_MAX_CR;
                      const isBig =
                        c.market_cap_cr != null &&
                        c.market_cap_cr >= 5_000;
                      return (
                      <div
                        key={`${r.person_id}-${c.ticker}`}
                        className={`gov-co${isTi ? " gov-co-ti" : ""}${isTiny ? " gov-co-tiny" : ""}${isBig ? " gov-co-big" : ""}`}
                      >
                        <div className="gov-co-top">
                          <div>
                            <div className="gov-co-name">
                              {c.name}{" "}
                              <span className="mono">({c.ticker})</span>
                              {c.cap_code ? (
                                <span
                                  className={`result-tag tag-cap-${c.cap_code.toLowerCase()}`}
                                >
                                  {c.cap_code}
                                </span>
                              ) : null}
                              {isTi ? (
                                <span className="gov-tag gov-tag-ti">
                                  &lt;₹100 Cr
                                </span>
                              ) : null}
                              {isTiny ? (
                                <span className="gov-tag gov-tag-tiny">
                                  &lt;₹500 Cr
                                </span>
                              ) : null}
                              {c.is_sme ? (
                                <span className="gov-tag gov-tag-sme">SME</span>
                              ) : null}
                              {c.has_edge ? (
                                <span className="gov-tag gov-tag-edge">Edge</span>
                              ) : null}
                              <FundWatchlistTags
                                tags={c.fund_tags}
                                changes={c.fund_changes}
                                tagClass="gov-tag"
                              />
                              {c.has_hold ? (
                                <span className="gov-tag gov-tag-hold">
                                  Hold
                                </span>
                              ) : null}
                              {c.has_bb ? (
                                <span className="gov-tag gov-tag-bb">BB</span>
                              ) : null}
                              {c.has_tq ? (
                                <span className="gov-tag gov-tag-tq">TQ</span>
                              ) : null}
                            </div>
                            <div className="gov-co-meta">
                              {[c.designation, c.category]
                                .filter(Boolean)
                                .join(" · ")}
                              {c.headquarters ? ` · ${c.headquarters}` : ""}
                              {c.sector ? ` · ${c.sector}` : ""}
                              {c.market_cap_cr != null
                                ? ` · ₹${formatMcap(c.market_cap_cr)} Cr`
                                : ""}
                            </div>
                          </div>
                          <div className="gov-co-links">
                            {c.web ? (
                              <a href={c.web} target="_blank" rel="noreferrer">
                                Web
                              </a>
                            ) : null}
                            <a href={c.sc} target="_blank" rel="noreferrer">
                              SC
                            </a>
                            <a href={c.tv} target="_blank" rel="noreferrer">
                              TV
                            </a>
                          </div>
                        </div>
                        {c.about || c.headquarters ? (
                          <GovAbout
                            about={c.about || ""}
                            headquarters={c.headquarters}
                          />
                        ) : null}
                      </div>
                      );
                    })}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}

      {view === "company" && ready ? (
        <div className="gov-list">
          {companyRows.map((c) => {
            const directors = c.directors ?? [];
            return (
              <article key={c.ticker} className="gov-card">
                <div className="gov-card-head static">
                  <div className="gov-dir">
                    <div className="gov-dir-name">
                      {c.name}{" "}
                      <span className="mono">({c.ticker})</span>
                      {c.cap_code ? (
                        <span
                          className={`result-tag tag-cap-${c.cap_code.toLowerCase()}`}
                        >
                          {c.cap_code}
                        </span>
                      ) : null}
                      {c.has_edge ? (
                        <span className="gov-tag gov-tag-edge">Edge</span>
                      ) : null}
                      <FundWatchlistTags
                        tags={c.fund_tags}
                        changes={c.fund_changes}
                        tagClass="gov-tag"
                      />
                      {c.has_hold ? (
                        <span className="gov-tag gov-tag-hold">Hold</span>
                      ) : null}
                      {c.has_bb ? (
                        <span className="gov-tag gov-tag-bb">BB</span>
                      ) : null}
                      {c.has_tq ? (
                        <span className="gov-tag gov-tag-tq">TQ</span>
                      ) : null}
                    </div>
                    <div className="gov-dir-sub">
                      {c.market}
                      {c.market_cap_cr != null
                        ? ` · ₹${formatMcap(c.market_cap_cr)} Cr`
                        : ""}
                      {` · ${directors.length} multi-board directors`}
                    </div>
                  </div>
                  <div className="gov-co-links">
                    {c.web ? (
                      <a href={c.web} target="_blank" rel="noreferrer">
                        Web
                      </a>
                    ) : null}
                    <a href={c.sc} target="_blank" rel="noreferrer">
                      SC
                    </a>
                    <a href={c.tv} target="_blank" rel="noreferrer">
                      TV
                    </a>
                  </div>
                </div>
                {c.about || c.headquarters ? (
                  <GovAbout
                    about={c.about || ""}
                    headquarters={c.headquarters}
                  />
                ) : null}
                <ul className="gov-dir-list">
                  {directors
                    .slice()
                    .sort((a, b) => b.dir_score - a.dir_score)
                    .map((d) => (
                      <li key={`${c.ticker}-${d.person_id}`}>
                        <span className="gov-score inline">
                          {d.dir_score.toFixed(1)}
                        </span>
                        <span>
                          {d.name}
                          {d.din_backed ? (
                            <span className="gov-badge">DIN</span>
                          ) : null}
                        </span>
                        <span className="muted">
                          {[d.designation, d.category]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </li>
                    ))}
                </ul>
              </article>
            );
          })}
        </div>
      ) : null}

      {data && data.pages > 1 ? (
        <div className="pager">
          <button
            type="button"
            className="btn-ghost"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <span>
            Page {data.page} / {data.pages}
          </span>
          <button
            type="button"
            className="btn-ghost"
            disabled={page >= data.pages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
