"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CompanyTable, type SortKey } from "@/components/CompanyTable";
import {
  MarketCapRangeBar,
  MCAP_RANGE_STEPS,
  mcapBoundsNarrowed,
  mcapCrToIndex,
  resolveMcapBounds,
  type McapExactBounds,
} from "@/components/MarketCapRangeBar";
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

const MCAP_DEFAULT_MAX = MCAP_RANGE_STEPS.length - 1;

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
    mrsi?: string | null;
  };
};

export function ScanPanel() {
  const [list, setList] = useState<ScanList>("All");
  const [mcapMinIndex, setMcapMinIndex] = useState(0);
  const [mcapMaxIndex, setMcapMaxIndex] = useState(MCAP_DEFAULT_MAX);
  const [mcapExact, setMcapExact] = useState<McapExactBounds | null>(null);
  const [filterHold, setFilterHold] = useState(false);
  const [filterGov, setFilterGov] = useState(false);
  const [fundAllCount, setFundAllCount] = useState(0);
  const [filterFundAll, setFilterFundAll] = useState(false);
  const [filterSme, setFilterSme] = useState(false);
  const [filterNote, setFilterNote] = useState(false);
  const [ageMin, setAgeMin] = useState<number | null>(null);
  const [scanScope, setScanScope] = useState<ScanScope>("list");
  const [view, setView] = useState<ViewFilter>("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const hasDataRef = useRef(false);
  const loadSeqRef = useRef(0);
  hasDataRef.current = !!data;
  const [listCounts, setListCounts] = useState<Record<string, number>>({
    hold: 0,
    gov: 0,
    sme: 0,
    note: 0,
    age25: 0,
    age50: 0,
    age100: 0,
    age_min: 0,
    distress: 0,
    ...Object.fromEntries(FUND_WATCHLIST_KEYS.map((k) => [k, 0])),
  });

  const mcapBounds = resolveMcapBounds(mcapMinIndex, mcapMaxIndex, mcapExact);
  const mcapNarrowed = mcapBoundsNarrowed(mcapBounds.minCr, mcapBounds.maxCr);
  const filtersKey = [
    list,
    mcapBounds.minCr ?? "",
    mcapBounds.maxCr ?? "",
    view,
    filterHold,
    filterGov,
    filterFundAll,
    filterSme,
    filterNote,
    ageMin,
  ].join("|");
  // Page belongs to one filter set: any filter change starts at page 1.
  // (Before, page 1 loaded once, then the old page number reloaded on the
  // next render — "401–500 of 1,068" right after toggling SME on page 5.)
  const [pageAt, setPageAt] = useState({ key: filtersKey, page: 1 });
  const page = pageAt.key === filtersKey ? pageAt.page : 1;
  const setPage = useCallback(
    (next: number | ((p: number) => number)) =>
      setPageAt((prev) => {
        const cur = prev.key === filtersKey ? prev.page : 1;
        return {
          key: filtersKey,
          page: typeof next === "function" ? next(cur) : next,
        };
      }),
    [filtersKey],
  );
  const pageForLoad = page;

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      const seq = ++loadSeqRef.current;
      const isRefresh = opts?.refresh === true;
      if (!hasDataRef.current || isRefresh) setLoading(true);
      if (isRefresh) setRefreshing(true);
      const params = new URLSearchParams({
        market: list,
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
      if (view === "mrsi") params.set("mrsi", "1");
      if (view === "mrsi85") params.set("mrsi85", "1");
      if (view === "mrsi_empty") params.set("mrsi_empty", "1");
      if (filterHold) params.set("hold", "1");
      if (filterGov) params.set("gov", "1");
      if (filterFundAll) params.set("fundMode", "all");
      if (filterSme) params.set("sme", "1");
      if (filterNote) params.set("note", "1");
      if (ageMin != null) params.set("ageMin", String(ageMin));
      const { minCr, maxCr } = mcapBounds;
      if (minCr != null && minCr > 0) params.set("mcapMin", String(minCr));
      if (maxCr != null) params.set("mcapMax", String(maxCr));
      if (isRefresh) params.set("refresh", "1");
      try {
        const res = await fetch(`/api/companies?${params}`, {
          cache: isRefresh ? "no-store" : "default",
        });
        if (seq !== loadSeqRef.current) return;
        if (!res.ok) {
          // Don't leave the previous filter's rows looking like this result.
          setLoadError(`Could not load stocks (HTTP ${res.status}). Showing the previous result.`);
          return;
        }
        const json = (await res.json()) as ApiResponse;
        if (seq !== loadSeqRef.current) return;
        setLoadError(null);
        setData(json);
        if (json.signals) {
          setListCounts({
            hold: json.signals.hold ?? 0,
            gov: json.signals.gov ?? 0,
            sme: json.signals.sme ?? 0,
            note: json.signals.note ?? 0,
            age25: json.signals.age25 ?? 0,
            age50: json.signals.age50 ?? 0,
            age100: json.signals.age100 ?? 0,
            age_min: json.signals.age_min ?? 0,
            distress: json.signals.distress ?? 0,
            ...Object.fromEntries(
              FUND_WATCHLIST_KEYS.map((k) => [k, json.signals?.[k] ?? 0]),
            ),
          });
        }
      } catch (err) {
        if (seq !== loadSeqRef.current) return;
        setLoadError(
          `Could not load stocks (${err instanceof Error ? err.message : String(err)}). Showing the previous result.`,
        );
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [
      list,
      mcapBounds.minCr,
      mcapBounds.maxCr,
      view,
      pageForLoad,
      sort,
      dir,
      filterHold,
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
        key === "rsi_rank"
          ? "asc"
          : key === "price" ||
              key === "mcap_cr" ||
              key === "rsi_m" ||
              key === "pead_score"
            ? "desc"
            : "asc",
      );
    }
  }

  const signalMode: "rsi" | null =
    view === "mrsi" || view === "mrsi85" || view === "mrsi_empty"
      ? "rsi"
      : null;

  const onView = useCallback(
    (next: ViewFilter) => {
      setView(next);
      setPage(1);
      if (
        next === "mrsi" ||
        next === "mrsi85" ||
        next === "mrsi_empty"
      ) {
        setSort("rsi_rank");
        setDir("asc");
      } else if (
        sort === "rsi_m" ||
        sort === "rsi_rank" ||
        sort === "pead_score"
      ) {
        setSort("name");
        setDir("asc");
      }
    },
    [sort, setPage],
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
    if (mcapNarrowed) {
      const { minCr, maxCr } = mcapBounds;
      if (minCr != null && minCr > 0 && maxCr != null) {
        parts.push(`Mcap ${minCr}–${maxCr}`);
      } else if (minCr != null && minCr > 0) {
        parts.push(`Mcap ≥${minCr}`);
      } else if (maxCr != null) {
        parts.push(`Mcap ≤${maxCr}`);
      }
    }
    if (filterFundAll) parts.push("Funds");
    if (filterNote) parts.push("Note");
    if (filterGov) parts.push("Gov");
    if (filterSme) parts.push("SME");
    if (filterHold) parts.push("Hold");
    if (ageMin != null) parts.push(`Age ≥${ageMin}`);
    const base = scanListLabel(list);
    return parts.length ? `${base} · ${parts.join(" · ")}` : base;
  }, [
    list,
    mcapNarrowed,
    mcapBounds,
    filterFundAll,
    filterNote,
    filterGov,
    filterSme,
    filterHold,
    ageMin,
  ]);
  const selectionActive = hasScanSelection({
    hold: filterHold,
    gov: filterGov,
    sme: filterSme,
    note: filterNote,
    ageMin,
    funds: EMPTY_FUNDS,
    fundAll: filterFundAll,
    mcapNarrowed,
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
              setMcapMinIndex(0);
              setMcapMaxIndex(MCAP_DEFAULT_MAX);
              setMcapExact(null);
              setFilterHold(false);
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
        <div className="scan-filter-row scan-filter-row--lists-tags">
          <div className="scan-filter-group">
            <span className="scan-filter-label">Lists</span>
            <WatchlistFilterBar
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
            />
          </div>
          <div className="scan-filter-group">
            <span className="scan-filter-label">Tags</span>
            <FundsFilterBar
              hold={filterHold}
              gov={filterGov}
              onHold={setFilterHold}
              onGov={setFilterGov}
              holdCount={data?.signals?.hold ?? listCounts.hold}
              distressCount={data?.signals?.distress ?? listCounts.distress}
              govCount={data?.signals?.gov ?? listCounts.gov}
            />
          </div>
        </div>
        <div className="scan-filter-row scan-mcap-row">
          <span className="scan-filter-label">Mcap</span>
          <MarketCapRangeBar
            compact
            valueOnly
            minIndex={mcapMinIndex}
            maxIndex={mcapMaxIndex}
            minCr={mcapBounds.minCr}
            maxCr={mcapBounds.maxCr}
            onChange={(lo, hi) => {
              setMcapMinIndex(lo);
              setMcapMaxIndex(hi);
              setMcapExact(null);
              setPage(1);
            }}
            onCrChange={(minCr, maxCr) => {
              setMcapExact({ minCr: minCr ?? 0, maxCr });
              setMcapMinIndex(mcapCrToIndex(minCr ?? 0));
              setMcapMaxIndex(mcapCrToIndex(maxCr));
              setPage(1);
            }}
            onClear={
              mcapNarrowed
                ? () => {
                    setMcapMinIndex(0);
                    setMcapMaxIndex(MCAP_DEFAULT_MAX);
                    setMcapExact(null);
                    setPage(1);
                  }
                : undefined
            }
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
          hold={filterHold}
          gov={filterGov}
          sme={filterSme}
          note={filterNote}
          ageMin={ageMin}
          funds={EMPTY_FUNDS}
          fundAll={filterFundAll}
          mcapMin={mcapNarrowed ? mcapBounds.minCr : null}
          mcapMax={mcapNarrowed ? mcapBounds.maxCr : null}
          bbCount={data?.signals?.bb}
          bbWCount={data?.signals?.bb_w}
          bbMCount={data?.signals?.bb_m}
          tqCount={data?.signals?.tq}
          emaCount={data?.signals?.ema}
          mrsiCount={data?.signals?.mrsi}
          mrsi85Count={data?.signals?.mrsi85}
          mrsiEmptyCount={data?.signals?.mrsi_empty}
          bbDate={data?.session?.bb ?? null}
          bbWDate={data?.session?.bb_w ?? data?.session?.bb ?? null}
          bbMDate={data?.session?.bb_m ?? null}
          tqDate={data?.session?.tq ?? null}
          emaDate={data?.session?.ema ?? null}
          mrsiDate={data?.session?.mrsi ?? null}
          onBatch={softReload}
          onDone={hardReload}
        />
      </div>

      {emptyFiltered ? (
        <p className="scan-empty-hint">
          No {viewFilterLabel(view)} hits in {chipLabel}.
          {selectionActive ? (
            <>
              {" "}
              Clear tags (e.g. SME / Age ≥25) or switch List, then click{" "}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setFilterSme(false);
                  setFilterHold(false);
                  setFilterGov(false);
                  setFilterNote(false);
                  setAgeMin(null);
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
              Tags scope), or{" "}
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

      {loadError ? (
        <p className="scan-empty-hint">
          {loadError}{" "}
          <button type="button" className="link-btn" onClick={hardReload}>
            Retry
          </button>
        </p>
      ) : null}
      {loading && !data ? <div className="loading">Loading…</div> : null}

      <CompanyTable
        rows={data?.rows ?? []}
        sort={sort}
        dir={dir}
        onSort={onSort}
        signalMode={signalMode}
        hideBrief
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
