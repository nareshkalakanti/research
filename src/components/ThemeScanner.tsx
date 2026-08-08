"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CapMarketFilters,
  type CapFilter,
} from "@/components/CapMarketFilters";
import { CompanyTable, type SortKey } from "@/components/CompanyTable";
import { FillMissingButton } from "@/components/FillMissingButton";
import { RefreshButton } from "@/components/RefreshButton";
import { ScanFilters } from "@/components/ScanFilters";
import { ThemeMultiselect } from "@/components/ThemeMultiselect";
import type { Company, Theme, ThemeGroup } from "@/lib/types";

type ThemesApi = {
  meta: { syntax?: string; source_blog?: string; updated?: string };
  themes: Theme[];
  groups: ThemeGroup[];
};

type ScanApi = {
  rows: Company[];
  total: number;
  page: number;
  pages: number;
  scanPattern: string | null;
  markets: Record<string, number>;
  signals?: { bb: number; tq: number };
  breakoutsPreferred?: boolean;
};

export function ThemeScanner() {
  const [groups, setGroups] = useState<ThemeGroup[]>([]);
  const [meta, setMeta] = useState<ThemesApi["meta"]>({});
  const [markets, setMarkets] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [debouncedCustom, setDebouncedCustom] = useState("");
  const [market, setMarket] = useState("NSE");
  const [cap, setCap] = useState<CapFilter>("All");
  const [sme, setSme] = useState(false);
  const [filterBb, setFilterBb] = useState(false);
  const [filterTq, setFilterTq] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("sector");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ScanApi | null>(null);
  const [loading, setLoading] = useState(false);
  const [signalCounts, setSignalCounts] = useState<{ bb: number; tq: number }>({
    bb: 0,
    tq: 0,
  });

  useEffect(() => {
    void fetch("/api/themes")
      .then((r) => r.json())
      .then((j: ThemesApi) => {
        setGroups(j.groups);
        setMeta(j.meta ?? {});
      });
    void fetch("/api/companies?market=All&pageSize=10")
      .then((r) => r.json())
      .then(
        (j: {
          markets: Record<string, number>;
          signals?: { bb: number; tq: number };
        }) => {
          setMarkets(j.markets ?? {});
          if (j.signals) setSignalCounts(j.signals);
        },
      );
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedCustom(custom), 300);
    return () => clearTimeout(t);
  }, [custom]);

  useEffect(() => {
    setPage(1);
  }, [selected, debouncedCustom, market, cap, sme, filterBb, filterTq]);

  const active = selected.length > 0 || debouncedCustom.trim().length > 0;
  const listMarket = sme ? "NSE SME" : market;

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      if (!active) {
        setData(null);
        return;
      }
      setLoading(true);
      const params = new URLSearchParams({
        scan: "1",
        themes: selected.join(","),
        custom: debouncedCustom,
        market: listMarket,
        cap,
        page: String(page),
        pageSize: "100",
        sort,
        dir,
      });
      if (filterBb) params.set("bb", "1");
      if (filterTq) params.set("tq", "1");
      // When chips are off: if any theme hits have BB/TQ, show only those.
      if (!filterBb && !filterTq) params.set("preferBreakouts", "1");
      if (opts?.refresh) params.set("refresh", "1");
      try {
        const res = await fetch(`/api/companies?${params}`);
        const json = (await res.json()) as ScanApi;
        setData(json);
        if (json.markets) setMarkets(json.markets);
        if (json.signals) setSignalCounts(json.signals);
      } finally {
        setLoading(false);
      }
    },
    [
      active,
      selected,
      debouncedCustom,
      listMarket,
      cap,
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

  const selectedThemes = useMemo(() => {
    const all = groups.flatMap((g) => g.themes);
    return all.filter((t) => selected.includes(t.id));
  }, [groups, selected]);

  function onSort(key: SortKey) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(key === "price" || key === "mcap_cr" ? "desc" : "asc");
    }
  }

  const start = data ? (data.page - 1) * 100 + 1 : 0;
  const end = data ? Math.min(data.page * 100, data.total) : 0;
  const nseCount = markets["NSE"] ?? 0;
  const smeCount = markets["NSE SME"] ?? 0;

  return (
    <div className="panel">
      <div className="scanner-hero">
        <div>
          <h2>Theme Scanner</h2>
          <p>
            Match company about-text against investment themes.
            {meta.syntax ? ` Syntax: ${meta.syntax}.` : null}
          </p>
        </div>
        <div className="scanner-hero-right">
          <RefreshButton
            busy={loading}
            onRefresh={async () => {
              await fetch("/api/companies?market=All&pageSize=10&refresh=1")
                .then((r) => r.json())
                .then((j: { markets?: Record<string, number> }) => {
                  if (j.markets) setMarkets(j.markets);
                });
              await load({ refresh: true });
            }}
          />
        </div>
      </div>

      <div className="scanner-controls">
        <div className="scanner-col">
          <label className="field-label">Themes</label>
          <ThemeMultiselect
            groups={groups}
            selected={selected}
            onChange={setSelected}
          />
        </div>
        <div className="scanner-col">
          <label className="field-label" htmlFor="custom-kw">
            Custom keywords
          </label>
          <div className="search-bar">
            <span className="search-icon" aria-hidden>
              ⌕
            </span>
            <input
              id="custom-kw"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="acsr | copper | transformer oil"
            />
          </div>
          <p className="hint tight">
            Pipe-separated OR · use + for AND inside a clause
          </p>
        </div>
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
            <option value="NSE">NSE ({nseCount.toLocaleString() || "…"})</option>
            <option value="NSE SME">
              NSE SME ({smeCount.toLocaleString() || "…"})
            </option>
            <option value="All">All</option>
          </select>
        </label>
      </div>

      {selectedThemes.length > 0 ? (
        <div className="active-themes">
          {selectedThemes.map((t) => (
            <button
              key={t.id}
              type="button"
              className="active-theme"
              onClick={() => setSelected((s) => s.filter((id) => id !== t.id))}
              title={t.display_pattern}
            >
              {t.name}
              <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      ) : null}

      {data?.scanPattern ? (
        <div className="pattern-preview">
          <span>Scanning</span>
          <code>{data.scanPattern}</code>
        </div>
      ) : null}

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
          bbCount={data?.signals?.bb ?? signalCounts.bb}
          tqCount={data?.signals?.tq ?? signalCounts.tq}
          market={listMarket}
          pageTickers={data?.rows.map((r) => r.ticker)}
          onDone={() => void load({ refresh: true })}
        />
        <div className="pager">
          <span>
            {!active
              ? "Select themes or enter keywords to scan"
              : data
                ? `${start.toLocaleString()}–${end.toLocaleString()} of ${data.total.toLocaleString()} matches${
                    data.breakoutsPreferred ? " · BB/TQ only" : ""
                  }`
                : loading
                  ? "Scanning…"
                  : "—"}
          </span>
          {active && data ? (
            <div className="pager-btns">
              <button
                type="button"
                disabled={data.page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ‹
              </button>
              <span>
                {data.page}/{data.pages}
              </span>
              <button
                type="button"
                disabled={data.page >= data.pages}
                onClick={() => setPage((p) => p + 1)}
              >
                ›
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {data?.rows?.length ? (
        <div className="filters end">
          <FillMissingButton
            variant="inline"
            market={listMarket}
            tickers={data.rows.map((r) => r.ticker)}
            gapCount={
              data.rows.filter((r) => r.price == null || r.mcap_cr == null)
                .length
            }
            onDone={() => void load({ refresh: true })}
          />
        </div>
      ) : null}

      {!active ? (
        <div className="empty-state">
          Pick one or more themes (grouped by blog theme), or type custom
          keywords like <code>acsr | copper</code>.
        </div>
      ) : (
        <>
          {loading && !data ? <div className="loading">Scanning…</div> : null}
          <CompanyTable
            rows={data?.rows ?? []}
            sort={sort}
            dir={dir}
            onSort={onSort}
            showMatched
            capFilter={cap}
          />
        </>
      )}
    </div>
  );
}
