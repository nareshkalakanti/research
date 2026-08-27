"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CapFilter,
} from "@/components/CapMarketFilters";
import { CompanyTable, type SortKey } from "@/components/CompanyTable";
import { FillMissingButton } from "@/components/FillMissingButton";
import { RefreshButton } from "@/components/RefreshButton";
import {
  SignalScanBar,
  viewFilterLabel,
  type BbTimeframe,
  type ViewFilter,
} from "@/components/SignalScanBar";
import { WebsiteScrapeBar } from "@/components/WebsiteScrapeBar";
import { isScanWatchlist, scanListLabel, type ScanList } from "@/lib/scan-lists";
import {
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
} from "@/lib/fund-watchlist-meta";
import type { Company } from "@/lib/types";

type ApiResponse = {
  rows: Company[];
  total: number;
  page: number;
  pages: number;
  markets: Record<string, number>;
  signals?: Record<string, number>;
  session?: {
    bb: string | null;
    tq: string | null;
    ema?: string | null;
    ath?: string | null;
    high52?: string | null;
    dd?: string | null;
    mom?: string | null;
  };
};

export function ScanPanel() {
  const [list, setList] = useState<ScanList>("All");
  const [cap, setCap] = useState<CapFilter>("All");
  const [bbTimeframe, setBbTimeframe] = useState<BbTimeframe>("weekly");
  const [view, setView] = useState<ViewFilter>("all");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("sector");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const hasDataRef = useRef(false);
  const loadSeqRef = useRef(0);
  hasDataRef.current = !!data;
  const [listCounts, setListCounts] = useState<Record<string, number>>({
    hold: 0,
    edge: 0,
    ...Object.fromEntries(FUND_WATCHLIST_KEYS.map((k) => [k, 0])),
  });

  useEffect(() => {
    void fetch("/api/companies?market=All&pageSize=1")
      .then((r) => r.json())
      .then((j: ApiResponse) => {
        if (j.signals) {
          setListCounts({
            hold: j.signals.hold ?? 0,
            edge: j.signals.edge ?? 0,
            ...Object.fromEntries(
              FUND_WATCHLIST_KEYS.map((k) => [k, j.signals?.[k] ?? 0]),
            ),
          });
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
    if (view === "mom") {
      setSort("momentum_rank");
      setDir("asc");
    }
  }, [list, cap, view, bbTimeframe]);

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      const seq = ++loadSeqRef.current;
      if (!hasDataRef.current) setLoading(true);
      const params = new URLSearchParams({
        market: list,
        cap,
        bbTf: bbTimeframe,
        page: String(page),
        pageSize: "100",
        sort,
        dir,
      });
      if (view === "bb") params.set("bb", "1");
      if (view === "tq") params.set("tq", "1");
      if (view === "ema") params.set("ema", "1");
      if (view === "ath") params.set("ath", "1");
      if (view === "high52") params.set("high52", "1");
      if (view === "dd") params.set("dd", "1");
      if (view === "mom") params.set("mom", "1");
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
            ...Object.fromEntries(
              FUND_WATCHLIST_KEYS.map((k) => [k, json.signals?.[k] ?? 0]),
            ),
          });
        }
      } finally {
        if (seq === loadSeqRef.current) setLoading(false);
      }
    },
    [list, cap, bbTimeframe, view, page, sort, dir],
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
        key === "price" || key === "mcap_cr" || key === "momentum_pct"
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
  const pageTickers = data?.rows.map((r) => r.ticker) ?? [];
  const pageGaps = data?.rows.filter((r) => r.price == null || r.mcap_cr == null)
    .length;
  const selectedLabel = scanListLabel(list);
  const emptyFiltered =
    !loading && data && data.total === 0 && view !== "all";

  return (
    <div className="panel">
      <div className="toolbar">
        <label className="field">
          <span>List</span>
          <select
            value={list}
            onChange={(e) => setList(e.target.value as ScanList)}
          >
            <optgroup label="Universe">
              <option value="All">All ({allCount.toLocaleString()})</option>
              <option value="NSE">NSE ({nseCount.toLocaleString()})</option>
              <option value="NSE SME">
                NSE SME ({smeCount.toLocaleString()})
              </option>
              <option value="BSE SME">
                BSE SME ({bseSmeCount.toLocaleString()})
              </option>
            </optgroup>
            <optgroup label="Watchlists">
              <option value="Hold">
                Holdings ({listCounts.hold.toLocaleString()})
              </option>
              <option value="Edge">
                Edge ({listCounts.edge.toLocaleString()})
              </option>
              {FUND_WATCHLIST_KEYS.map((key) => (
                <option key={key} value={FUND_WATCHLIST_LABELS[key]}>
                  {FUND_WATCHLIST_LABELS[key]} (
                  {(listCounts[key] ?? 0).toLocaleString()})
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        <label className="field">
          <span>BB</span>
          <select
            value={bbTimeframe}
            onChange={(e) =>
              setBbTimeframe(e.target.value as BbTimeframe)
            }
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>

        <div className="toolbar-actions">
          <RefreshButton
            busy={loading}
            onRefresh={hardReload}
          />
          <FillMissingButton
            variant="inline"
            market={list}
            tickers={pageTickers}
            gapCount={pageGaps}
            onDone={softReload}
          />
        </div>
      </div>

      <div className="filters filters-compact">
        <SignalScanBar
          listLabel={selectedLabel}
          view={view}
          onView={setView}
          market={list}
          bbTimeframe={bbTimeframe}
          cap={cap}
          onCap={setCap}
          showCap={!isScanWatchlist(list)}
          bbCount={data?.signals?.bb}
          tqCount={data?.signals?.tq}
          emaCount={data?.signals?.ema}
          athCount={data?.signals?.ath}
          high52Count={data?.signals?.high52}
          ddCount={data?.signals?.dd}
          momCount={data?.signals?.mom}
          bbDate={data?.session?.bb ?? null}
          tqDate={data?.session?.tq ?? null}
          emaDate={data?.session?.ema ?? null}
          athDate={data?.session?.ath ?? null}
          high52Date={data?.session?.high52 ?? null}
          ddDate={data?.session?.dd ?? null}
          momDate={data?.session?.mom ?? null}
          onBatch={softReload}
          onDone={hardReload}
        />
        <WebsiteScrapeBar
          market={list}
          tickers={pageTickers}
          listLabel={selectedLabel}
          onBatch={softReload}
          onDone={softReload}
        />
      </div>

      {emptyFiltered ? (
        <p className="scan-empty-hint">
          No {viewFilterLabel(view)} hits in {selectedLabel}. Click{" "}
          <strong>Scan {viewFilterLabel(view)}</strong> above to refresh signals,
          or <button type="button" className="link-btn" onClick={() => setView("all")}>All stocks</button> to
          see the full list.
        </p>
      ) : null}

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
          <div className="pager">
            <span>
              {data
                ? `${start.toLocaleString()}–${end.toLocaleString()} of ${data.total.toLocaleString()} · ${selectedLabel}${
                    view !== "all" ? ` · ${viewFilterLabel(view)} hits` : ""
                  }`
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
        }
      />
    </div>
  );
}
