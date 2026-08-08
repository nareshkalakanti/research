"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CapMarketFilters,
  type CapFilter,
} from "@/components/CapMarketFilters";
import { CompanyTable, type SortKey } from "@/components/CompanyTable";
import { FillMissingButton } from "@/components/FillMissingButton";
import { RefreshButton } from "@/components/RefreshButton";
import { ScanFilters } from "@/components/ScanFilters";
import type { Company } from "@/lib/types";

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
  signals?: { bb: number; tq: number };
};

export function WatchingPanel() {
  const [market, setMarket] = useState("NSE");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [mode, setMode] = useState<"AND" | "OR">("OR");
  const [cap, setCap] = useState<CapFilter>("All");
  const [sme, setSme] = useState(false);
  const [filterBb, setFilterBb] = useState(false);
  const [filterTq, setFilterTq] = useState(false);
  const [sector, setSector] = useState("All");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("sector");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [market, debouncedQ, mode, cap, sme, sector, filterBb, filterTq]);

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      setLoading(true);
      const params = new URLSearchParams({
        market: sme ? "NSE SME" : market,
        q: debouncedQ,
        mode,
        cap,
        sector,
        page: String(page),
        pageSize: "100",
        sort,
        dir,
      });
      if (filterBb) params.set("bb", "1");
      if (filterTq) params.set("tq", "1");
      if (opts?.refresh) params.set("refresh", "1");
      try {
        const res = await fetch(`/api/companies?${params}`);
        const json = (await res.json()) as ApiResponse;
        setData(json);
      } finally {
        setLoading(false);
      }
    },
    [
      market,
      debouncedQ,
      mode,
      cap,
      sme,
      sector,
      filterBb,
      filterTq,
      page,
      sort,
      dir,
    ],
  );

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

  const listMarket = sme ? "NSE SME" : market;
  const markets = data?.markets ?? {};
  const nseCount = markets["NSE"] ?? 0;
  const smeCount = markets["NSE SME"] ?? 0;
  const start = data ? (data.page - 1) * 100 + 1 : 0;
  const end = data ? Math.min(data.page * 100, data.total) : 0;
  const pageTickers = data?.rows.map((r) => r.ticker) ?? [];
  const pageGaps = data?.rows.filter((r) => r.price == null || r.mcap_cr == null)
    .length;

  return (
    <div className="panel">
      <div className="toolbar">
        <label className="field">
          <span>List</span>
          <select
            value={sme ? "NSE SME" : market}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "NSE SME") {
                setSme(true);
                setMarket("NSE SME");
              } else {
                setSme(false);
                setMarket(v);
              }
            }}
          >
            <option value="NSE">NSE ({nseCount.toLocaleString()})</option>
            <option value="NSE SME">NSE SME ({smeCount.toLocaleString()})</option>
            <option value="All">
              All ({(nseCount + smeCount).toLocaleString()})
            </option>
          </select>
        </label>
        <div className="toolbar-actions">
          <RefreshButton
            busy={loading}
            onRefresh={() => load({ refresh: true })}
          />
          <FillMissingButton
            variant="inline"
            market={listMarket}
            tickers={pageTickers}
            gapCount={pageGaps}
            totalGaps={data?.gaps?.metrics ?? 0}
            onDone={() => void load({ refresh: true })}
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
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search companies"
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
      </div>

      <div className="filters">
        <CapMarketFilters
          cap={cap}
          onCap={setCap}
          sme={sme}
          onSme={(next) => {
            setSme(next);
            if (!next && market === "NSE SME") setMarket("NSE");
          }}
        />
        <ScanFilters
          bb={filterBb}
          tq={filterTq}
          onBb={setFilterBb}
          onTq={setFilterTq}
          bbCount={data?.signals?.bb}
          tqCount={data?.signals?.tq}
          market={listMarket}
          pageTickers={pageTickers}
          onDone={() => void load({ refresh: true })}
        />
        <label className="field sector-field">
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
              ? `${start.toLocaleString()}–${end.toLocaleString()} of ${data.total.toLocaleString()} · ${sme ? "NSE SME" : market}`
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
      </div>

      {loading && !data ? <div className="loading">Loading…</div> : null}
      <CompanyTable
        rows={data?.rows ?? []}
        sort={sort}
        dir={dir}
        onSort={onSort}
        capFilter={cap}
      />
    </div>
  );
}
