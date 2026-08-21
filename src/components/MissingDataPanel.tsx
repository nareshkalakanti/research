"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CompanyTable, type SortKey } from "@/components/CompanyTable";
import { FillMissingButton } from "@/components/FillMissingButton";
import { RefreshButton } from "@/components/RefreshButton";
import type { Company } from "@/lib/types";

type GapKey =
  | "metrics"
  | "price"
  | "mcap"
  | "sector"
  | "sub_sector"
  | "about"
  | "web"
  | "any";

type Gaps = {
  missingPrice: number;
  missingMcap: number;
  missingSector: number;
  missingSubSector: number;
  missingAbout: number;
  missingWeb: number;
  any: number;
  metrics: number;
};

type ApiResponse = {
  rows: Company[];
  total: number;
  page: number;
  pages: number;
  markets: Record<string, number>;
  gaps?: Gaps;
};

const GAP_OPTIONS: { id: GapKey; label: string; countKey: keyof Gaps }[] = [
  { id: "metrics", label: "Price / Mcap", countKey: "metrics" },
  { id: "price", label: "Price", countKey: "missingPrice" },
  { id: "mcap", label: "Mcap", countKey: "missingMcap" },
  { id: "sector", label: "Sector / Sub", countKey: "missingSector" },
  { id: "sub_sector", label: "Sub-sector", countKey: "missingSubSector" },
  { id: "about", label: "About", countKey: "missingAbout" },
  { id: "web", label: "Web", countKey: "missingWeb" },
  { id: "any", label: "Any gap", countKey: "any" },
];

export function MissingDataPanel() {
  const [market, setMarket] = useState("All");
  const [gap, setGap] = useState<GapKey>("metrics");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const hasDataRef = useRef(false);
  hasDataRef.current = !!data;

  useEffect(() => {
    setPage(1);
  }, [market, gap]);

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      if (!hasDataRef.current) setLoading(true);
      const params = new URLSearchParams({
        market,
        missing: gap,
        page: String(page),
        pageSize: "100",
        sort,
        dir,
      });
      if (opts?.refresh) params.set("refresh", "1");
      try {
        const res = await fetch(`/api/companies?${params}`);
        const json = (await res.json()) as ApiResponse;
        setData(json);
      } finally {
        setLoading(false);
      }
    },
    [market, gap, page, sort, dir],
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

  const markets = data?.markets ?? {};
  const nseCount = markets["NSE"] ?? 0;
  const smeCount = markets["NSE SME"] ?? 0;
  const bseSmeCount = markets["BSE SME"] ?? 0;
  const allCount = Object.values(markets).reduce((a, b) => a + b, 0);
  const gaps = data?.gaps;
  const start = data ? (data.page - 1) * 100 + 1 : 0;
  const end = data ? Math.min(data.page * 100, data.total) : 0;
  const pageTickers = data?.rows.map((r) => r.ticker) ?? [];
  const fillableGaps = data?.rows.filter(
    (r) => r.missing?.price || r.missing?.mcap,
  ).length;
  const totalMetricsGaps = gaps?.metrics ?? 0;
  const gapLabel =
    GAP_OPTIONS.find((o) => o.id === gap)?.label.toLowerCase() ?? gap;

  return (
    <div className="panel">
      <div className="missing-head">
        <div>
          <h2>Missing data</h2>
          <p className="missing-sub">
            Gaps for <strong>{market}</strong>
            {gaps ? (
              <>
                {" "}
                · <strong>{(gaps.metrics ?? 0).toLocaleString()}</strong> need
                price/mcap
              </>
            ) : null}
            {" "}
            · includes Niveshaay &amp; Negen watchlists
          </p>
        </div>
        <div className="missing-head-actions">
          <RefreshButton
            busy={loading}
            onRefresh={() => load({ refresh: true })}
          />
        </div>
      </div>

      <FillMissingButton
        market={market}
        tickers={pageTickers}
        gapCount={fillableGaps}
        totalGaps={totalMetricsGaps}
        onDone={() => load({ refresh: true })}
      />

      <div className="toolbar">
        <label className="field">
          <span>List</span>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
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
        <label className="field">
          <span>Show</span>
          <select
            value={gap}
            onChange={(e) => setGap(e.target.value as GapKey)}
          >
            {GAP_OPTIONS.map((o) => {
              const n = gaps?.[o.countKey] ?? 0;
              return (
                <option key={o.id} value={o.id}>
                  {o.label} ({n.toLocaleString()})
                </option>
              );
            })}
          </select>
        </label>
        <a
          className="btn-download btn-download-inline"
          href={`/api/export?market=${encodeURIComponent(market)}&missing=${encodeURIComponent(gap)}&format=basic`}
          download
          title="company name · symbol · website"
        >
          Download CSV
        </a>
      </div>
      <p className="hint tight missing-export-hint">
        CSV columns: <strong>company name</strong>, <strong>symbol</strong>,{" "}
        <strong>website</strong> — all rows for the selected list and gap filter
        {data ? ` (${data.total.toLocaleString()} stocks)` : null}.
      </p>

      <div className="filters">
        <div className="pager">
          <span>
            {data
              ? `${start.toLocaleString()}–${end.toLocaleString()} of ${data.total.toLocaleString()} · ${gapLabel}`
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

      {!loading && data && data.total === 0 ? (
        <div className="empty-state ok-state">
          No gaps for this filter — data looks complete.
        </div>
      ) : (
        <CompanyTable
          rows={data?.rows ?? []}
          sort={sort}
          dir={dir}
          onSort={onSort}
          showMissing
        />
      )}
    </div>
  );
}
