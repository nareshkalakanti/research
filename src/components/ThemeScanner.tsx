"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { type CapFilter } from "@/components/CapMarketFilters";
import { CompanyTable, type SortKey } from "@/components/CompanyTable";
import { RefreshButton } from "@/components/RefreshButton";
import { WatchlistFilterBar, FundsFilterBar } from "@/components/WatchlistFilterBar";
import { SavedSearchesBar } from "@/components/SavedSearchesBar";
import { ThemeMultiselect } from "@/components/ThemeMultiselect";
import type { Company, Theme, ThemeGroup } from "@/lib/types";
import type { SavedSearchRow } from "@/lib/saved-searches";
import {
  appendFundParams,
  anyFundFilterActive,
  clearFundFilters,
  FUND_WATCHLIST_KEYS,
  type FundCountState,
  type FundFilterState,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";

const EMPTY_FUNDS = Object.fromEntries(
  FUND_WATCHLIST_KEYS.map((k) => [k, false]),
) as FundFilterState;

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
  sectors?: string[];
  sub_sectors?: string[];
  gaps?: {
    missingPrice?: number;
    missingMcap?: number;
    any?: number;
    metrics?: number;
  };
  signals?: Record<string, number>;
};

export function ThemeScanner() {
  const [groups, setGroups] = useState<ThemeGroup[]>([]);
  const [meta, setMeta] = useState<ThemesApi["meta"]>({});
  const [markets, setMarkets] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [debouncedCustom, setDebouncedCustom] = useState("");
  const [activeSavedId, setActiveSavedId] = useState<number | null>(null);
  const [market, setMarket] = useState("All");
  const [cap, setCap] = useState<CapFilter>("All");
  const [filterHold, setFilterHold] = useState(false);
  const [filterEdge, setFilterEdge] = useState(false);
  const [fundFilters, setFundFilters] = useState<FundFilterState>(EMPTY_FUNDS);
  const setFund = useCallback((key: FundWatchlistKey, on: boolean) => {
    setFundFilters((prev) => ({ ...prev, [key]: on }));
  }, []);
  const clearFunds = useCallback(() => {
    setFundFilters(clearFundFilters());
  }, []);
  const [filterSme, setFilterSme] = useState(false);
  const [filterNote, setFilterNote] = useState(false);
  const [sector, setSector] = useState("All");
  const [subSector, setSubSector] = useState("All");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("sector");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ScanApi | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signalCounts, setSignalCounts] = useState<Record<string, number>>({
    hold: 0,
    distress: 0,
    edge: 0,
    sme: 0,
    note: 0,
    NC: 0,
    TI: 0,
    MIC: 0,
    SC: 0,
    MC: 0,
    LC: 0,
    ...Object.fromEntries(FUND_WATCHLIST_KEYS.map((k) => [k, 0])),
  });

  useEffect(() => {
    void fetch("/api/themes")
      .then((r) => r.json())
      .then((j: ThemesApi) => {
        setGroups(j.groups ?? []);
        setMeta(j.meta ?? {});
      })
      .catch(() => {
        setGroups([]);
      });
    void fetch("/api/companies?market=All&pageSize=10")
      .then((r) => r.json())
      .then(
        (j: {
          markets?: Record<string, number>;
          signals?: Record<string, number>;
        }) => {
          if (j.markets) setMarkets(j.markets);
          if (j.signals) {
            setSignalCounts((prev) => ({ ...prev, ...j.signals }));
          }
        },
      );
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedCustom(custom), 300);
    return () => clearTimeout(t);
  }, [custom]);

  useEffect(() => {
    setPage(1);
  }, [
    selected,
    debouncedCustom,
    market,
    cap,
    sector,
    subSector,
    filterHold,
    filterEdge,
    fundFilters,
    filterSme,
    filterNote,
  ]);

  const fundsActive = anyFundFilterActive(fundFilters);
  const active =
    selected.length > 0 ||
    debouncedCustom.trim().length > 0 ||
    fundsActive ||
    filterHold ||
    filterEdge;

  const selectedThemes = useMemo(() => {
    const all = groups.flatMap((g) => g.themes);
    return all.filter((t) => selected.includes(t.id));
  }, [groups, selected]);

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      if (!active) {
        setData(null);
        setLoadError(null);
        // Restore baseline chip counts after Clear / deselect (not fund-scoped leftovers).
        try {
          const res = await fetch("/api/companies?market=All&pageSize=10");
          const json = (await res.json()) as {
            markets?: Record<string, number>;
            signals?: Record<string, number>;
          };
          if (json.markets) setMarkets(json.markets);
          if (json.signals) {
            setSignalCounts((prev) => ({ ...prev, ...json.signals }));
          }
        } catch {
          /* keep last counts */
        }
        return;
      }
      setLoading(true);
      setLoadError(null);
      const params = new URLSearchParams({
        scan: "1",
        themes: selected.join(","),
        custom: debouncedCustom,
        market,
        cap,
        sector,
        subSector,
        page: String(page),
        pageSize: "100",
        sort,
        dir,
      });
      if (filterHold) params.set("hold", "1");
      if (filterEdge) params.set("edge", "1");
      if (filterSme) params.set("sme", "1");
      if (filterNote) params.set("note", "1");
      appendFundParams(params, fundFilters);
      if (opts?.refresh) params.set("refresh", "1");
      try {
        const res = await fetch(`/api/companies?${params}`);
        if (!res.ok) {
          setLoadError(`Load failed (${res.status})`);
          return;
        }
        const json = (await res.json()) as ScanApi;
        setData(json);
        if (json.markets) setMarkets(json.markets);
        if (json.signals) {
          setSignalCounts((prev) => ({ ...prev, ...json.signals }));
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Load failed");
      } finally {
        setLoading(false);
      }
    },
    [
      active,
      selected,
      debouncedCustom,
      market,
      cap,
      sector,
      subSector,
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

  const start = data ? (data.page - 1) * 100 + 1 : 0;
  const end = data ? Math.min(data.page * 100, data.total) : 0;
  const nseCount = markets["NSE"] ?? 0;
  const smeCount = markets["NSE SME"] ?? 0;
  const bseSmeCount = markets["BSE SME"] ?? 0;
  const allCount = Object.values(markets).reduce((a, b) => a + b, 0);

  return (
    <div className="panel">
      <div className="scanner-hero">
        <div>
          <h2>Theme</h2>
          <p>
            Match company about-text against investment themes
            {meta.syntax ? ` · ${meta.syntax}` : ""}.
          </p>
        </div>
        <div className="scanner-hero-right scanner-hero-actions">
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
            onChange={(ids) => {
              setSelected(ids);
              setActiveSavedId(null);
            }}
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
              onChange={(e) => {
                setCustom(e.target.value);
                setActiveSavedId(null);
              }}
              placeholder="acsr | copper | transformer oil"
              autoComplete="off"
            />
            {custom ? (
              <button
                type="button"
                className="theme-search-clear"
                onClick={() => {
                  setCustom("");
                  setActiveSavedId(null);
                }}
                aria-label="Clear keywords"
              >
                ×
              </button>
            ) : null}
          </div>
          <p className="hint tight">
            Pipe = OR · + = AND inside a clause
            {selected.length > 0 ? " · narrows selected themes" : ""}
          </p>
          <SavedSearchesBar
            scope="theme"
            pattern={custom}
            activeId={activeSavedId}
            onApply={(s: SavedSearchRow) => {
              setActiveSavedId(s.id);
              setCustom(s.pattern);
            }}
          />
        </div>
        <label className="field">
          <span>List</span>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="All">All ({allCount.toLocaleString() || "…"})</option>
            <option value="NSE">NSE ({nseCount.toLocaleString() || "…"})</option>
            <option value="NSE SME">
              NSE SME ({smeCount.toLocaleString() || "…"})
            </option>
            <option value="BSE SME">
              BSE SME ({bseSmeCount.toLocaleString() || "…"})
            </option>
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

      <div className="scan-filter-stack theme-filter-stack">
        <div className="scan-filter-row">
          <span className="scan-filter-label">Lists</span>
          <WatchlistFilterBar
            cap={cap}
            onCap={setCap}
            sme={filterSme}
            note={filterNote}
            onSme={setFilterSme}
            onNote={setFilterNote}
            smeCount={data?.signals?.sme ?? signalCounts.sme}
            noteCount={data?.signals?.note ?? signalCounts.note}
            allCount={
              data?.total ??
              Object.values(markets).reduce((a, b) => a + b, 0)
            }
            capCounts={{
              NC: data?.signals?.NC ?? signalCounts.NC,
              TI: data?.signals?.TI ?? signalCounts.TI,
              MIC: data?.signals?.MIC ?? signalCounts.MIC,
              SC: data?.signals?.SC ?? signalCounts.SC,
              MC: data?.signals?.MC ?? signalCounts.MC,
              LC: data?.signals?.LC ?? signalCounts.LC,
            }}
          />
        </div>
        <div className="scan-filter-row">
          <span className="scan-filter-label">Funds</span>
          <FundsFilterBar
            hold={filterHold}
            edge={filterEdge}
            onHold={setFilterHold}
            onEdge={setFilterEdge}
            holdCount={data?.signals?.hold ?? signalCounts.hold}
            distressCount={data?.signals?.distress ?? signalCounts.distress}
            edgeCount={data?.signals?.edge ?? signalCounts.edge}
            funds={fundFilters}
            onFund={setFund}
            onClearFunds={clearFunds}
            fundCounts={
              Object.fromEntries(
                FUND_WATCHLIST_KEYS.map((k) => [
                  k,
                  data?.signals?.[k] ?? signalCounts[k] ?? 0,
                ]),
              ) as FundCountState
            }
          />
        </div>
      </div>

      {loadError ? (
        <div className="empty-state theme-load-error">{loadError}</div>
      ) : null}
      {!active ? (
        <div className="empty-state">
          Select themes, keywords, or fund chips to scan
        </div>
      ) : null}
      {loading && !data ? <div className="loading">Scanning…</div> : null}
      <CompanyTable
        rows={data?.rows ?? []}
        sort={sort}
        dir={dir}
        onSort={onSort}
        showMatched={active}
        capFilter={cap}
        onNoteChange={() => void load()}
        onScrapeDone={() => void load()}
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
            <label className="field sector-field sector-field--table">
              <span>Sub-sector</span>
              <select
                value={subSector}
                onChange={(e) => setSubSector(e.target.value)}
              >
                <option value="All">All sub-sectors</option>
                {(data?.sub_sectors ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <div className="pager">
              <span>
                {!active
                  ? "—"
                  : data
                    ? `${start.toLocaleString()}–${end.toLocaleString()} of ${data.total.toLocaleString()} · ${market}`
                    : loading
                      ? "…"
                      : "—"}
              </span>
              {data ? (
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
          </>
        }
      />
    </div>
  );
}
