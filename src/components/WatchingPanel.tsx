"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CapFilter } from "@/components/CapMarketFilters";
import { CompanyTable, type SortKey } from "@/components/CompanyTable";
import { FillMissingButton } from "@/components/FillMissingButton";
import { RefreshButton } from "@/components/RefreshButton";
import { WatchlistFilterBar } from "@/components/WatchlistFilterBar";
import { SavedSearchesBar } from "@/components/SavedSearchesBar";
import {
  appendFundParams,
  FUND_WATCHLIST_KEYS,
  type FundCountState,
  type FundFilterState,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";
import type { Company } from "@/lib/types";
import type { SavedSearchRow } from "@/lib/saved-searches";

type ApiResponse = {
  rows: Company[];
  total: number;
  page: number;
  pages: number;
  markets: Record<string, number>;
  sectors: string[];
  gaps?: {
    missingPrice: number;
    missingMcap: number;
    any: number;
    metrics: number;
  };
  signals?: Record<string, number>;
  session?: { bb: string | null; tq: string | null; ema?: string | null };
};

const EMPTY_FUNDS = Object.fromEntries(
  FUND_WATCHLIST_KEYS.map((k) => [k, false]),
) as FundFilterState;

export function WatchingPanel() {
  const [market, setMarket] = useState("All");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [activeSavedId, setActiveSavedId] = useState<number | null>(null);
  const [mode, setMode] = useState<"AND" | "OR">("OR");
  const [cap, setCap] = useState<CapFilter>("All");
  const [filterHold, setFilterHold] = useState(false);
  const [filterEdge, setFilterEdge] = useState(false);
  const [fundFilters, setFundFilters] = useState<FundFilterState>(EMPTY_FUNDS);
  const [filterSme, setFilterSme] = useState(false);
  const [filterNote, setFilterNote] = useState(false);
  const [sector, setSector] = useState("All");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("sector");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const hasDataRef = useRef(false);
  const loadSeqRef = useRef(0);
  hasDataRef.current = !!data;

  const setFund = useCallback((key: FundWatchlistKey, on: boolean) => {
    setFundFilters((prev) => ({ ...prev, [key]: on }));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [market, debouncedQ, mode, cap, sector, filterHold, filterEdge, fundFilters, filterSme, filterNote]);

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      const seq = ++loadSeqRef.current;
      if (!hasDataRef.current) setLoading(true);
      const params = new URLSearchParams({
        market,
        q: debouncedQ,
        mode,
        cap,
        sector,
        page: String(page),
        pageSize: "100",
        sort,
        dir,
      });
      if (filterHold) params.set("hold", "1");
      if (filterEdge) params.set("edge", "1");
      appendFundParams(params, fundFilters);
      if (filterSme) params.set("sme", "1");
      if (filterNote) params.set("note", "1");
      if (opts?.refresh) params.set("refresh", "1");
      try {
        const res = await fetch(`/api/companies?${params}`);
        if (seq !== loadSeqRef.current) return;
        if (!res.ok) {
          const body = await res.text();
          console.error("Companies load failed:", res.status, body.slice(0, 200));
          return;
        }
        const json = (await res.json()) as ApiResponse;
        if (seq !== loadSeqRef.current) return;
        setData(json);
      } finally {
        if (seq === loadSeqRef.current) setLoading(false);
      }
    },
    [
      market,
      debouncedQ,
      mode,
      cap,
      sector,
      filterHold,
      filterEdge,
      fundFilters,
      filterSme,
      filterNote,
      page,
      sort,
      dir,
    ],
  );

  const loadRef = useRef(load);
  loadRef.current = load;
  const softReload = useCallback(() => {
    void loadRef.current();
  }, []);
  const hardReload = useCallback(() => {
    void loadRef.current({ refresh: true });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function onSort(key: SortKey) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(key === "price" || key === "mcap_cr" ? "desc" : "asc");
    }
  }

  const fundCounts = useMemo((): FundCountState => {
    const sig = data?.signals ?? {};
    return Object.fromEntries(
      FUND_WATCHLIST_KEYS.map((k) => [k, sig[k]]),
    ) as FundCountState;
  }, [data?.signals]);

  const listMarket = market;
  const markets = data?.markets ?? {};
  const nseCount = markets["NSE"] ?? 0;
  const smeCount = markets["NSE SME"] ?? 0;
  const bseSmeCount = markets["BSE SME"] ?? 0;
  const allCount = Object.values(markets).reduce((a, b) => a + b, 0);
  const start = data ? (data.page - 1) * 100 + 1 : 0;
  const end = data ? Math.min(data.page * 100, data.total) : 0;
  const rowIdentity = useMemo(
    () => (data?.rows ?? []).map((r) => `${r.market}:${r.ticker}`).join("|"),
    [data?.rows],
  );
  const pageTickers = useMemo(
    () => (data?.rows ?? []).map((r) => r.ticker),
    [rowIdentity],
  );
  const pageGaps = useMemo(
    () =>
      (data?.rows ?? []).filter((r) => r.price == null || r.mcap_cr == null)
        .length,
    [rowIdentity, data?.rows],
  );

  return (
    <div className="panel">
      <div className="toolbar">
        <label className="field">
          <span>List</span>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="All">All ({allCount.toLocaleString()})</option>
            <option value="NSE">NSE ({nseCount.toLocaleString()})</option>
            <option value="NSE SME">NSE SME ({smeCount.toLocaleString()})</option>
            <option value="BSE SME">
              BSE SME ({bseSmeCount.toLocaleString()})
            </option>
          </select>
        </label>
        <div className="toolbar-actions">
          <RefreshButton busy={loading} onRefresh={hardReload} />
          <FillMissingButton
            variant="inline"
            market={listMarket}
            tickers={pageTickers}
            gapCount={pageGaps}
            totalGaps={data?.gaps?.metrics ?? 0}
            onDone={softReload}
          />
        </div>
      </div>

      <div className="search-block">
        <div className="search-bar">
          <span className="search-icon" aria-hidden>
            ⌕
          </span>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActiveSavedId(null);
            }}
            placeholder="Search companies — e.g. copper | uranium"
            aria-label="Search companies"
          />
        </div>
        <div className="search-meta">
          <div className="mode-toggle">
            <button
              type="button"
              className={mode === "AND" ? "on" : undefined}
              onClick={() => setMode("AND")}
            >
              AND
            </button>
            <span>|</span>
            <button
              type="button"
              className={mode === "OR" ? "on" : undefined}
              onClick={() => setMode("OR")}
            >
              OR
            </button>
          </div>
          <span className="hint">e.g. acsr | copper | transformer oil</span>
        </div>
        <SavedSearchesBar
          scope="watching"
          pattern={q}
          activeId={activeSavedId}
          onApply={(s: SavedSearchRow) => {
            setActiveSavedId(s.id);
            setQ(s.pattern);
          }}
        />
      </div>

      <div className="filters filters-compact">
        <WatchlistFilterBar
          cap={cap}
          onCap={setCap}
          hold={filterHold}
          edge={filterEdge}
          funds={fundFilters}
          onFund={setFund}
          sme={filterSme}
          note={filterNote}
          onHold={setFilterHold}
          onEdge={setFilterEdge}
          onSme={setFilterSme}
          onNote={setFilterNote}
          holdCount={data?.signals?.hold}
          distressCount={data?.signals?.distress}
          edgeCount={data?.signals?.edge}
          fundCounts={fundCounts}
          smeCount={data?.signals?.sme}
          noteCount={data?.signals?.note}
        />
      </div>

      {loading && !data ? <div className="loading">Loading…</div> : null}
      <CompanyTable
        rows={data?.rows ?? []}
        sort={sort}
        dir={dir}
        onSort={onSort}
        capFilter={cap}
        onNoteChange={softReload}
        onScrapeDone={softReload}
        toolbar={
          <>
            <label className="field sector-field sector-field--table">
              <span>Sector</span>
              <select value={sector} onChange={(e) => setSector(e.target.value)}>
                <option value="All">All sectors</option>
                {(data?.sectors ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <div className="pager">
              <span>
                {data
                  ? `${start.toLocaleString()}–${end.toLocaleString()} of ${data.total.toLocaleString()} · ${market}`
                  : "…"}
              </span>
              <div className="pager-btns">
                <button
                  type="button"
                  disabled={!data || data.page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  ‹
                </button>
                <span>
                  {data?.page ?? 1}/{data?.pages ?? 1}
                </span>
                <button
                  type="button"
                  disabled={!data || data.page >= data.pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  ›
                </button>
              </div>
            </div>
          </>
        }
      />
    </div>
  );
}
