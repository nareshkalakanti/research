"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CapFilter,
} from "@/components/CapMarketFilters";
import { CompanyTable, type SortKey } from "@/components/CompanyTable";
import { RefreshButton } from "@/components/RefreshButton";
import {
  SignalScanBar,
  hasScanSelection,
  viewFilterLabel,
  type ScanScope,
  type ViewFilter,
} from "@/components/SignalScanBar";
import { WatchlistFilterBar, FundsFilterBar } from "@/components/WatchlistFilterBar";
import { scanListLabel, type ScanList } from "@/lib/scan-lists";
import {
  FUND_WATCHLIST_KEYS,
  type FundFilterState,
} from "@/lib/fund-watchlist-meta";
import type { Company } from "@/lib/types";

const EMPTY_FUNDS = Object.fromEntries(
  FUND_WATCHLIST_KEYS.map((k) => [k, false]),
) as FundFilterState;

type ApiResponse = {
  rows: Company[];
  total: number;
  page: number;
  pages: number;
  markets: Record<string, number>;
  signals?: Record<string, number>;
  session?: {
    bb: string | null;
    bb_w?: string | null;
    bb_m?: string | null;
    tq: string | null;
    ema?: string | null;
    ath?: string | null;
    high52?: string | null;
    mom?: string | null;
    mrsi?: string | null;
  };
};

export function ScanPanel() {
  const [list, setList] = useState<ScanList>("All");
  const [cap, setCap] = useState<CapFilter>("All");
  const [filterHold, setFilterHold] = useState(false);
  const [filterEdge, setFilterEdge] = useState(false);
  const [filterGov, setFilterGov] = useState(false);
  const [fundAllCount, setFundAllCount] = useState(0);
  const [filterFundAll, setFilterFundAll] = useState(false);
  const [filterSme, setFilterSme] = useState(false);
  const [filterNote, setFilterNote] = useState(false);
  const [ageMin, setAgeMin] = useState<number | null>(null);
  const [scanScope, setScanScope] = useState<ScanScope>("list");
  const [view, setView] = useState<ViewFilter>("all");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const hasDataRef = useRef(false);
  const loadSeqRef = useRef(0);
  hasDataRef.current = !!data;
  const [listCounts, setListCounts] = useState<Record<string, number>>({
    hold: 0,
    edge: 0,
    gov: 0,
    sme: 0,
    note: 0,
    age25: 0,
    age50: 0,
    age100: 0,
    age_min: 0,
    distress: 0,
    NC: 0,
    TI: 0,
    MIC: 0,
    SC: 0,
    MC: 0,
    LC: 0,
    ...Object.fromEntries(FUND_WATCHLIST_KEYS.map((k) => [k, 0])),
  });

  const filtersKey = [
    list,
    cap,
    view,
    filterHold,
    filterEdge,
    filterGov,
    filterFundAll,
    filterSme,
    filterNote,
    ageMin,
  ].join("|");
  const filtersKeyRef = useRef(filtersKey);
  const pageForLoad =
    filtersKeyRef.current !== filtersKey ? 1 : page;
  if (filtersKeyRef.current !== filtersKey) {
    filtersKeyRef.current = filtersKey;
  }

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      const seq = ++loadSeqRef.current;
      const isRefresh = opts?.refresh === true;
      if (!hasDataRef.current || isRefresh) setLoading(true);
      if (isRefresh) setRefreshing(true);
      const params = new URLSearchParams({
        market: list,
        cap,
        bbTf: "weekly",
        page: String(pageForLoad),
        pageSize: "100",
        sort,
        dir,
      });
      if (view === "bb" || view === "bbw") params.set("bbw", "1");
      if (view === "bbm") params.set("bbm", "1");
      if (view === "tq") params.set("tq", "1");
      if (view === "ema") params.set("ema", "1");
      if (view === "ath") params.set("ath", "1");
      if (view === "high52") params.set("high52", "1");
      if (view === "mom") params.set("mom", "1");
      if (view === "mrsi") params.set("mrsi", "1");
      if (view === "mrsi85") params.set("mrsi85", "1");
      if (view === "mrsi_empty") params.set("mrsi_empty", "1");
      if (view === "opm") params.set("opm", "1");
      if (filterHold) params.set("hold", "1");
      if (filterEdge) params.set("edge", "1");
      if (filterGov) params.set("gov", "1");
      if (filterFundAll) params.set("fundMode", "all");
      if (filterSme) params.set("sme", "1");
      if (filterNote) params.set("note", "1");
      if (ageMin != null) params.set("ageMin", String(ageMin));
      if (isRefresh) params.set("refresh", "1");
      try {
        const res = await fetch(`/api/companies?${params}`, {
          cache: isRefresh ? "no-store" : "default",
        });
        if (seq !== loadSeqRef.current) return;
        if (!res.ok) {
          console.warn("[ScanPanel] refresh/load failed:", res.status);
          return;
        }
        const json = (await res.json()) as ApiResponse;
        if (seq !== loadSeqRef.current) return;
        setData(json);
        if (json.signals) {
          setListCounts({
            hold: json.signals.hold ?? 0,
            edge: json.signals.edge ?? 0,
            gov: json.signals.gov ?? 0,
            sme: json.signals.sme ?? 0,
            note: json.signals.note ?? 0,
            age25: json.signals.age25 ?? 0,
            age50: json.signals.age50 ?? 0,
            age100: json.signals.age100 ?? 0,
            age_min: json.signals.age_min ?? 0,
            distress: json.signals.distress ?? 0,
            NC: json.signals.NC ?? 0,
            TI: json.signals.TI ?? 0,
            MIC: json.signals.MIC ?? 0,
            SC: json.signals.SC ?? 0,
            MC: json.signals.MC ?? 0,
            LC: json.signals.LC ?? 0,
            ...Object.fromEntries(
              FUND_WATCHLIST_KEYS.map((k) => [k, json.signals?.[k] ?? 0]),
            ),
          });
        }
      } catch (err) {
        console.warn("[ScanPanel] load error:", err);
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [
      list,
      cap,
      view,
      pageForLoad,
      sort,
      dir,
      filterHold,
      filterEdge,
      filterGov,
      filterFundAll,
      filterSme,
      filterNote,
      ageMin,
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

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/fund-watchlists")
      .then((res) => res.json())
      .then((json: { all?: number }) => {
        if (!cancelled) setFundAllCount(json.all ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function onSort(key: SortKey) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(
        key === "momentum_rank" || key === "rsi_rank"
          ? "asc"
          : key === "price" ||
              key === "mcap_cr" ||
              key === "momentum_pct" ||
              key === "price_1y" ||
              key === "price_1m" ||
              key === "rsi_m"
            ? "desc"
            : "asc",
      );
    }
  }

  const signalMode: "mom" | "rsi" | null =
    view === "mom"
      ? "mom"
      : view === "mrsi" || view === "mrsi85" || view === "mrsi_empty"
        ? "rsi"
        : null;

  const onView = useCallback(
    (next: ViewFilter) => {
      setView(next);
      setPage(1);
      if (next === "mom") {
        setSort("momentum_rank");
        setDir("asc");
      } else if (
        next === "mrsi" ||
        next === "mrsi85" ||
        next === "mrsi_empty"
      ) {
        setSort("rsi_rank");
        setDir("asc");
      } else if (
        sort === "momentum_rank" ||
        sort === "momentum_pct" ||
        sort === "price_1y" ||
        sort === "price_1m" ||
        sort === "rsi_m" ||
        sort === "rsi_rank"
      ) {
        setSort("name");
        setDir("asc");
      }
    },
    [sort],
  );

  const markets = data?.markets ?? {};
  const nseCount = markets["NSE"] ?? 0;
  const smeCount = markets["NSE SME"] ?? 0;
  const bseSmeCount = markets["BSE SME"] ?? 0;
  const allCount = Object.values(markets).reduce((a, b) => a + b, 0);
  const start = data ? (data.page - 1) * 100 + 1 : 0;
  const end = data ? Math.min(data.page * 100, data.total) : 0;
  const chipLabel = useMemo(() => {
    const parts: string[] = [];
    if (cap !== "All") parts.push(cap);
    if (filterFundAll) parts.push("Funds");
    if (filterNote) parts.push("Note");
    if (filterEdge) parts.push("Edge");
    if (filterGov) parts.push("Gov");
    if (filterSme) parts.push("SME");
    if (filterHold) parts.push("Hold");
    if (ageMin != null) parts.push(`Age ≥${ageMin}`);
    const base = scanListLabel(list);
    return parts.length ? `${base} · ${parts.join(" · ")}` : base;
  }, [
    list,
    cap,
    filterFundAll,
    filterNote,
    filterEdge,
    filterGov,
    filterSme,
    filterHold,
    ageMin,
  ]);
  const selectionActive = hasScanSelection({
    cap,
    hold: filterHold,
    edge: filterEdge,
    gov: filterGov,
    sme: filterSme,
    note: filterNote,
    ageMin,
    funds: EMPTY_FUNDS,
    fundAll: filterFundAll,
  });
  useEffect(() => {
    if (selectionActive) setScanScope("selection");
    else setScanScope("list");
  }, [selectionActive]);
  useEffect(() => {
    if (view === "mrsi_empty" && (data?.signals?.mrsi_empty ?? 0) === 0) {
      onView("mrsi");
    }
  }, [view, data?.signals?.mrsi_empty, onView]);
  const emptyFiltered =
    !loading &&
    data &&
    data.total === 0 &&
    view !== "all";

  return (
    <div className="panel scan-panel">
      <div className="toolbar">
        <label className="field">
          <span>List</span>
          <select
            value={list}
            onChange={(e) => {
              setList(e.target.value as ScanList);
              setPage(1);
              setView("all");
              setCap("All");
              setFilterHold(false);
              setFilterEdge(false);
              setFilterGov(false);
              setFilterFundAll(false);
              setFilterSme(false);
              setFilterNote(false);
              setAgeMin(null);
            }}
          >
            <option value="All">All ({allCount.toLocaleString()})</option>
            <option value="NSE">NSE ({nseCount.toLocaleString()})</option>
            <option value="NSE SME">
              NSE SME ({smeCount.toLocaleString()})
            </option>
            <option value="BSE SME">
              BSE SME ({bseSmeCount.toLocaleString()})
            </option>
          </select>
        </label>

        <div className="toolbar-actions">
          <RefreshButton busy={loading || refreshing} onRefresh={hardReload} />
        </div>
      </div>

      <div className="scan-filter-stack">
        <div className="scan-filter-row">
          <span className="scan-filter-label">Lists</span>
          <WatchlistFilterBar
            cap={cap}
            onCap={setCap}
            funds={filterFundAll}
            onFunds={setFilterFundAll}
            fundsCount={fundAllCount}
            sme={filterSme}
            note={filterNote}
            ageMin={ageMin}
            onSme={setFilterSme}
            onNote={setFilterNote}
            onAgeMin={setAgeMin}
            smeCount={data?.signals?.sme ?? listCounts.sme}
            noteCount={data?.signals?.note ?? listCounts.note}
            ageCounts={{
              25: data?.signals?.age25 ?? listCounts.age25,
              50: data?.signals?.age50 ?? listCounts.age50,
              100: data?.signals?.age100 ?? listCounts.age100,
            }}
            allCount={allCount}
            capCounts={{
              NC: data?.signals?.NC ?? listCounts.NC,
              TI: data?.signals?.TI ?? listCounts.TI,
              MIC: data?.signals?.MIC ?? listCounts.MIC,
              SC: data?.signals?.SC ?? listCounts.SC,
              MC: data?.signals?.MC ?? listCounts.MC,
              LC: data?.signals?.LC ?? listCounts.LC,
            }}
          />
        </div>
        <div className="scan-filter-row">
          <span className="scan-filter-label">Tags</span>
          <FundsFilterBar
            hold={filterHold}
            edge={filterEdge}
            gov={filterGov}
            onHold={setFilterHold}
            onEdge={setFilterEdge}
            onGov={setFilterGov}
            holdCount={data?.signals?.hold ?? listCounts.hold}
            distressCount={data?.signals?.distress ?? listCounts.distress}
            edgeCount={data?.signals?.edge ?? listCounts.edge}
            govCount={data?.signals?.gov ?? listCounts.gov}
          />
        </div>
        <SignalScanBar
          listLabel={chipLabel}
          view={view}
          onView={onView}
          market={list}
          bbTimeframe="weekly"
          scope={scanScope}
          onScope={setScanScope}
          selectionActive={selectionActive}
          cap={cap}
          hold={filterHold}
          edge={filterEdge}
          gov={filterGov}
          sme={filterSme}
          note={filterNote}
          ageMin={ageMin}
          funds={EMPTY_FUNDS}
          fundAll={filterFundAll}
          bbCount={data?.signals?.bb}
          bbWCount={data?.signals?.bb_w}
          bbMCount={data?.signals?.bb_m}
          tqCount={data?.signals?.tq}
          emaCount={data?.signals?.ema}
          athCount={data?.signals?.ath}
          high52Count={data?.signals?.high52}
          momCount={data?.signals?.mom}
          mrsiCount={data?.signals?.mrsi}
          mrsi85Count={data?.signals?.mrsi85}
          mrsiEmptyCount={data?.signals?.mrsi_empty}
          opmCount={data?.signals?.operating_metrics}
          bbDate={data?.session?.bb ?? null}
          bbWDate={data?.session?.bb_w ?? data?.session?.bb ?? null}
          bbMDate={data?.session?.bb_m ?? null}
          tqDate={data?.session?.tq ?? null}
          emaDate={data?.session?.ema ?? null}
          athDate={data?.session?.ath ?? null}
          high52Date={data?.session?.high52 ?? null}
          momDate={data?.session?.mom ?? null}
          mrsiDate={data?.session?.mrsi ?? null}
          onBatch={softReload}
          onDone={hardReload}
        />
      </div>

      {emptyFiltered ? (
        <p className="scan-empty-hint">
          No {viewFilterLabel(view)} hits in {chipLabel}.
          {view === "opm" ? (
            <>
              {" "}
              Needs cached Sales+OP with Stable OPM and Sales YoY ≥5% (new
              listings: Stable OPM + QoQ sales &gt;0). Use{" "}
              <strong>Fill Quarters</strong> (List / Tags), open Quarters, or
              widen List.{" "}
            </>
          ) : selectionActive ? (
            <>
              {" "}
              Clear tags (e.g. SME / Age ≥25) or switch List, then click{" "}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setFilterSme(false);
                  setFilterHold(false);
                  setFilterEdge(false);
                  setFilterGov(false);
                  setFilterNote(false);
                  setAgeMin(null);
                  setCap("All");
                  setPage(1);
                }}
              >
                Show in All
              </button>
              , or{" "}
            </>
          ) : (
            <>
              {" "}
              Click <strong>Scan {viewFilterLabel(view)}</strong> above (List /
              Tags scope like 12M), or{" "}
            </>
          )}
          <button
            type="button"
            className="link-btn"
            onClick={() => onView("all")}
          >
            All stocks
          </button>{" "}
          for the full list.
        </p>
      ) : null}

      {signalMode === "mom" &&
      !loading &&
      data &&
      data.rows.length > 0 &&
      data.rows.filter((r) => r.momentum_pct == null).length >
        data.rows.length * 0.7 ? (
        <p className="scan-empty-hint">
          Rank / 1Y / 1M / Mom are empty until momentum is scanned. Click{" "}
          <strong>Scan 12m</strong> (or Scan all) in the Scan row.
        </p>
      ) : null}

      {loading && !data ? <div className="loading">Loading…</div> : null}

      <CompanyTable
        rows={data?.rows ?? []}
        sort={sort}
        dir={dir}
        onSort={onSort}
        signalMode={signalMode}
        capFilter={cap}
        onNoteChange={softReload}
        onScrapeDone={softReload}
        toolbar={
          <div className="pager">
            <span>
              {data
                ? `${start.toLocaleString()}–${end.toLocaleString()} of ${data.total.toLocaleString()} · ${chipLabel}${
                    view !== "all" ? ` · ${viewFilterLabel(view)} hits` : ""
                  }`
                : "…"}
            </span>
            <div className="pager-btns">
              <button
                type="button"
                disabled={!data || page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ‹
              </button>
              <span>
                {data ? `${Math.min(page, data.pages)}/${data.pages}` : "…"}
              </span>
              <button
                type="button"
                disabled={!data || page >= data.pages || loading}
                onClick={() =>
                  setPage((p) =>
                    data ? Math.min(data.pages, p + 1) : p + 1,
                  )
                }
              >
                ›
              </button>
            </div>
          </div>
        }
      />
    </div>
  );
}
