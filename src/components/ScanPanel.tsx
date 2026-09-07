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
  appendFundParams,
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  type FundCountState,
  type FundFilterState,
  type FundWatchlistKey,
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
  const [filterQuality, setFilterQuality] = useState(false);
  const [fundFilters, setFundFilters] = useState<FundFilterState>(EMPTY_FUNDS);
  const setFund = useCallback((key: FundWatchlistKey, on: boolean) => {
    setFundFilters((prev) => ({ ...prev, [key]: on }));
  }, []);
  const [filterSme, setFilterSme] = useState(false);
  const [filterNote, setFilterNote] = useState(false);
  const [scanScope, setScanScope] = useState<ScanScope>("list");
  const [view, setView] = useState<ViewFilter>("all");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("momentum_rank");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const hasDataRef = useRef(false);
  const loadSeqRef = useRef(0);
  hasDataRef.current = !!data;
  const [listCounts, setListCounts] = useState<Record<string, number>>({
    hold: 0,
    edge: 0,
    quality: 0,
    sme: 0,
    note: 0,
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
    filterQuality,
    filterSme,
    filterNote,
    FUND_WATCHLIST_KEYS.map((k) => (fundFilters[k] ? "1" : "0")).join(""),
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
      if (!hasDataRef.current) setLoading(true);
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
      if (view === "board") params.set("board", "1");
      if (filterHold) params.set("hold", "1");
      if (filterEdge) params.set("edge", "1");
      if (filterQuality) params.set("quality", "1");
      appendFundParams(params, fundFilters);
      if (filterSme) params.set("sme", "1");
      if (filterNote) params.set("note", "1");
      if (opts?.refresh) params.set("refresh", "1");
      try {
        const res = await fetch(`/api/companies?${params}`);
        if (seq !== loadSeqRef.current) return;
        if (!res.ok) return;
        const json = (await res.json()) as ApiResponse;
        if (seq !== loadSeqRef.current) return;
        setData(json);
        if (json.signals) {
          setListCounts({
            hold: json.signals.hold ?? 0,
            edge: json.signals.edge ?? 0,
            quality: json.signals.quality ?? 0,
            sme: json.signals.sme ?? 0,
            note: json.signals.note ?? 0,
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
      } finally {
        if (seq === loadSeqRef.current) setLoading(false);
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
        filterQuality,
      fundFilters,
      filterSme,
      filterNote,
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
      setDir(
        key === "momentum_rank"
          ? "asc"
          : key === "price" ||
              key === "mcap_cr" ||
              key === "momentum_pct" ||
              key === "price_1y" ||
              key === "price_1m"
            ? "desc"
            : "asc",
      );
    }
  }

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
    if (filterNote) parts.push("Note");
    if (filterEdge) parts.push("Edge");
    if (filterQuality) parts.push("Quality");
    for (const key of FUND_WATCHLIST_KEYS) {
      if (fundFilters[key]) parts.push(FUND_WATCHLIST_LABELS[key]);
    }
    if (filterSme) parts.push("SME");
    if (filterHold) parts.push("Hold");
    const base = scanListLabel(list);
    return parts.length ? `${base} · ${parts.join(" · ")}` : base;
  }, [list, cap, filterNote, filterEdge, filterQuality, fundFilters, filterSme, filterHold]);
  const selectionActive = hasScanSelection({
    cap,
    hold: filterHold,
    edge: filterEdge,
    quality: filterQuality,
    sme: filterSme,
    note: filterNote,
    funds: fundFilters,
  });
  useEffect(() => {
    if (selectionActive) setScanScope("selection");
    else setScanScope("list");
  }, [selectionActive]);
  useEffect(() => {
    if (view === "mrsi_empty" && (data?.signals?.mrsi_empty ?? 0) === 0) {
      setView("mrsi");
    }
  }, [view, data?.signals?.mrsi_empty]);
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
              setFilterQuality(false);
              setFilterSme(false);
              setFilterNote(false);
              setFundFilters(EMPTY_FUNDS);
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
          <RefreshButton busy={loading} onRefresh={hardReload} />
        </div>
      </div>

      <div className="scan-filter-stack">
        <div className="scan-filter-row">
          <span className="scan-filter-label">Lists</span>
          <WatchlistFilterBar
            cap={cap}
            onCap={setCap}
            sme={filterSme}
            note={filterNote}
            onSme={setFilterSme}
            onNote={setFilterNote}
            smeCount={data?.signals?.sme ?? listCounts.sme}
            noteCount={data?.signals?.note ?? listCounts.note}
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
          <span className="scan-filter-label">Funds</span>
          <FundsFilterBar
            hold={filterHold}
            edge={filterEdge}
            quality={filterQuality}
            onHold={setFilterHold}
            onEdge={setFilterEdge}
            onQuality={setFilterQuality}
            holdCount={data?.signals?.hold ?? listCounts.hold}
            distressCount={data?.signals?.distress ?? listCounts.distress}
            edgeCount={data?.signals?.edge ?? listCounts.edge}
            qualityCount={data?.signals?.quality ?? listCounts.quality}
            funds={fundFilters}
            onFund={setFund}
            fundCounts={
              Object.fromEntries(
                FUND_WATCHLIST_KEYS.map((k) => [
                  k,
                  data?.signals?.[k] ?? listCounts[k] ?? 0,
                ]),
              ) as FundCountState
            }
          />
        </div>
        <SignalScanBar
          listLabel={chipLabel}
          view={view}
          onView={(v) => {
            setView(v);
            setPage(1);
            if (v === "board") {
              setSort("board_score");
              setDir("desc");
            } else if (sort === "board_score" || sort === "board_dirs" || sort === "board_top") {
              setSort("momentum_rank");
              setDir("asc");
            }
          }}
          market={list}
          bbTimeframe="weekly"
          scope={scanScope}
          onScope={setScanScope}
          selectionActive={selectionActive}
          cap={cap}
          hold={filterHold}
          edge={filterEdge}
          quality={filterQuality}
          sme={filterSme}
          note={filterNote}
          funds={fundFilters}
          bbCount={data?.signals?.bb}
          bbWCount={data?.signals?.bb_w}
          bbMCount={data?.signals?.bb_m}
          tqCount={data?.signals?.tq}
          emaCount={data?.signals?.ema}
          athCount={data?.signals?.ath}
          high52Count={data?.signals?.high52}
          mrsiCount={data?.signals?.mrsi}
          mrsi85Count={data?.signals?.mrsi85}
          mrsiEmptyCount={data?.signals?.mrsi_empty}
          opmCount={data?.signals?.operating_metrics}
          boardCount={data?.signals?.board_rep}
          bbDate={data?.session?.bb ?? null}
          bbWDate={data?.session?.bb_w ?? data?.session?.bb ?? null}
          bbMDate={data?.session?.bb_m ?? null}
          tqDate={data?.session?.tq ?? null}
          emaDate={data?.session?.ema ?? null}
          athDate={data?.session?.ath ?? null}
          high52Date={data?.session?.high52 ?? null}
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
          ) : view === "board" ? (
            <>
              {" "}
              Needs DIN-backed multi-board directors in governance.db (cap
              bridge, Multi-LC, SME×mainboard, or score ≥50). Run Governance
              scan/fill first, then widen List.{" "}
            </>
          ) : selectionActive ? (
            <>
              {" "}
              Clear tags (e.g. SME) or switch List, then click{" "}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setFilterSme(false);
                  setFilterHold(false);
                  setFilterEdge(false);
                  setFilterNote(false);
                  setFundFilters(EMPTY_FUNDS);
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
              Tags scope like 12m), or{" "}
            </>
          )}
          <button
            type="button"
            className="link-btn"
            onClick={() => setView("all")}
          >
            All stocks
          </button>{" "}
          for the full list.
        </p>
      ) : null}

      {!loading &&
      view !== "board" &&
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
        showMomentum={view !== "board"}
        showBoardRep={view === "board"}
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
