"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CapFilter,
} from "@/components/CapMarketFilters";
import { CompanyTable, type SortKey } from "@/components/CompanyTable";
import { FillMissingButton } from "@/components/FillMissingButton";
import { RefreshButton } from "@/components/RefreshButton";
import { WatchlistFilterBar } from "@/components/WatchlistFilterBar";
import { SavedSearchesBar } from "@/components/SavedSearchesBar";
import { ThemeMultiselect } from "@/components/ThemeMultiselect";
import type { Company, Theme, ThemeGroup } from "@/lib/types";
import type { SavedSearchRow } from "@/lib/saved-searches";

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
  gaps?: Record<string, number>;
  signals?: {
    bb: number;
    tq: number;
    ema?: number;
    hold?: number;
    distress?: number;
    edge?: number;
    niveshaay?: number;
    negen?: number;
    sme?: number;
    note?: number;
  };
  session?: { bb: string | null; tq: string | null; ema?: string | null };
  breakoutsPreferred?: boolean;
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
  const [filterNiveshaay, setFilterNiveshaay] = useState(false);
  const [filterNegen, setFilterNegen] = useState(false);
  const [filterSme, setFilterSme] = useState(false);
  const [filterNote, setFilterNote] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("sector");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ScanApi | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const hasDataRef = useRef(false);
  const loadSeqRef = useRef(0);
  hasDataRef.current = !!data;
  const [signalCounts, setSignalCounts] = useState<{
    hold: number;
    distress: number;
    edge: number;
    niveshaay: number;
    negen: number;
    sme: number;
    note: number;
  }>({
    hold: 0,
    distress: 0,
    edge: 0,
    niveshaay: 0,
    negen: 0,
    sme: 0,
    note: 0,
  });

  useEffect(() => {
    void fetch("/api/themes")
      .then((r) => r.json())
      .then((j: ThemesApi) => {
        setGroups(j.groups);
        setMeta(j.meta ?? {});
      });
  }, []);

  useEffect(() => {
    void fetch(`/api/companies?market=${encodeURIComponent(market)}&pageSize=1`)
      .then(async (r) => {
        const raw = await r.text();
        if (!raw.trim() || !r.ok) return null;
        try {
          return JSON.parse(raw) as {
            markets: Record<string, number>;
            signals?: {
              bb: number;
              tq: number;
              ema?: number;
              hold?: number;
              distress?: number;
              edge?: number;
              niveshaay?: number;
              negen?: number;
              sme?: number;
              note?: number;
            };
          };
        } catch {
          return null;
        }
      })
      .then((j) => {
        if (!j) return;
        setMarkets(j.markets ?? {});
        if (j.signals) {
          setSignalCounts({
            hold: j.signals.hold ?? 0,
            distress: j.signals.distress ?? 0,
            edge: j.signals.edge ?? 0,
            niveshaay: j.signals.niveshaay ?? 0,
            negen: j.signals.negen ?? 0,
            sme: j.signals.sme ?? 0,
            note: j.signals.note ?? 0,
          });
        }
      });
  }, [market]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedCustom(custom), 300);
    return () => clearTimeout(t);
  }, [custom]);

  useEffect(() => {
    setPage(1);
  }, [selected, debouncedCustom, market, cap, filterHold, filterEdge, filterNiveshaay, filterNegen, filterSme, filterNote]);

  const themeActive = selected.length > 0 || debouncedCustom.trim().length > 0;
  const watchlistActive =
    filterHold || filterEdge || filterNiveshaay || filterNegen || filterSme || filterNote;
  const capActive = cap !== "All";
  const active = themeActive || watchlistActive || capActive;
  const listMarket = market;

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      const seq = ++loadSeqRef.current;
      if (!active) {
        setData(null);
        return;
      }
      if (!hasDataRef.current) setLoading(true);
      const params = new URLSearchParams({
        market: listMarket,
        cap,
        page: String(page),
        pageSize: "100",
        sort,
        dir,
      });
      if (themeActive) {
        params.set("scan", "1");
        params.set("themes", selected.join(","));
        params.set("custom", debouncedCustom);
      }
      if (filterHold) params.set("hold", "1");
      if (filterEdge) params.set("edge", "1");
      if (filterNiveshaay) params.set("niveshaay", "1");
      if (filterNegen) params.set("negen", "1");
      if (filterSme) params.set("sme", "1");
      if (filterNote) params.set("note", "1");
      if (opts?.refresh) params.set("refresh", "1");
      setLoadError(null);
      try {
        let res: Response;
        try {
          res = await fetch(`/api/companies?${params}`);
        } catch {
          throw new Error("Network error — is the dev server running?");
        }
        const raw = await res.text();
        if (!raw.trim()) {
          throw new Error(`Empty response (${res.status})`);
        }
        let json: ScanApi;
        try {
          json = JSON.parse(raw) as ScanApi;
        } catch {
          throw new Error(`Invalid JSON (${res.status})`);
        }
        if (!res.ok) {
          const msg =
            typeof (json as { error?: unknown }).error === "string"
              ? (json as { error: string }).error
              : `Request failed (${res.status})`;
          throw new Error(msg);
        }
        if (seq !== loadSeqRef.current) return;
        setData(json);
        if (json.markets) setMarkets(json.markets);
        if (json.signals) {
          setSignalCounts({
            hold: json.signals.hold ?? 0,
            distress: json.signals.distress ?? 0,
            edge: json.signals.edge ?? 0,
            niveshaay: json.signals.niveshaay ?? 0,
            negen: json.signals.negen ?? 0,
            sme: json.signals.sme ?? 0,
            note: json.signals.note ?? 0,
          });
        }
      } catch (e) {
        if (seq !== loadSeqRef.current) return;
        setLoadError(e instanceof Error ? e.message : "Load failed");
      } finally {
        if (seq === loadSeqRef.current) setLoading(false);
      }
    },
    [
      active,
      themeActive,
      selected,
      debouncedCustom,
      listMarket,
      cap,
      filterHold,
      filterEdge,
      filterNiveshaay,
      filterNegen,
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
  const bseSmeCount = markets["BSE SME"] ?? 0;
  const allCount = Object.values(markets).reduce((a, b) => a + b, 0);

  return (
    <div className="panel">
      <div className="scanner-hero">
        <div>
          <h2>Theme Scanner</h2>
          <p>
            Match keywords against About and stored website scrape text.
            {meta.syntax ? ` Syntax: ${meta.syntax}.` : null}
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
              await hardReload();
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
              onChange={(e) => {
                setCustom(e.target.value);
                setActiveSavedId(null);
              }}
              placeholder="optional: narrow with extra terms"
            />
          </div>
          <p className="hint tight">
            Pipe = OR, + = AND inside a clause. With a theme selected, custom
            keywords narrow results (AND) — they do not bypass the theme.
          </p>
          {selectedThemes.some((t) =>
            [
              "solar_epc_bess",
              "packaging_gravure",
              "aseptic_food_processing",
              "micro_irrigation",
              "seismic_geophysical",
              "progressive_cavity_pumps",
              "pvc_pipes_fittings",
            ].includes(t.id),
          ) ? (
            <p className="hint tight">
              Nanocap-style themes: results capped at ₹500 Cr mcap. Portfolio
              matches stay visible even with BB/TQ filters.
            </p>
          ) : null}
          {selectedThemes.some((t) =>
            [
              "hospitals_healthcare",
              "real_estate_redevelopment",
              "foundry_consumables",
              "gems_jewellery_lgd",
              "tmt_royalty",
              "coated_steel",
              "auto_components_adas",
              "pib_additives",
              "merchant_banking",
              "financials_infra",
              "gilts_primary_dealer",
            ].includes(t.id),
          ) &&
          !selectedThemes.some((t) =>
            [
              "solar_epc_bess",
              "packaging_gravure",
              "aseptic_food_processing",
              "micro_irrigation",
              "seismic_geophysical",
            ].includes(t.id),
          ) ? (
            <p className="hint tight">
              Listed-venture themes: results capped at ₹6,000 Cr mcap. Holdings
              in these themes are pinned to the top.
            </p>
          ) : null}
          <SavedSearchesBar
            scope="theme"
            pattern={custom}
            themeIds={selected}
            activeId={activeSavedId}
            onApply={(s: SavedSearchRow) => {
              setActiveSavedId(s.id);
              setSelected(s.theme_ids);
              setCustom(s.pattern);
            }}
          />
        </div>
        <label className="field">
          <span>List</span>
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value)}
          >
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

      <div className="filters filters-compact">
        <WatchlistFilterBar
          cap={cap}
          onCap={setCap}
          hold={filterHold}
          edge={filterEdge}
          niveshaay={filterNiveshaay}
          negen={filterNegen}
          sme={filterSme}
          note={filterNote}
          onHold={setFilterHold}
          onEdge={setFilterEdge}
          onNiveshaay={setFilterNiveshaay}
          onNegen={setFilterNegen}
          onSme={setFilterSme}
          onNote={setFilterNote}
          holdCount={data?.signals?.hold ?? signalCounts.hold}
          distressCount={data?.signals?.distress ?? signalCounts.distress}
          edgeCount={data?.signals?.edge ?? signalCounts.edge}
          niveshaayCount={data?.signals?.niveshaay ?? signalCounts.niveshaay}
          negenCount={data?.signals?.negen ?? signalCounts.negen}
          smeCount={data?.signals?.sme ?? signalCounts.sme}
          noteCount={data?.signals?.note ?? signalCounts.note}
        />
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
            onDone={() => void softReload()}
          />
        </div>
      ) : null}

      {!active ? (
        <div className="empty-state">
          Select themes, cap band, keywords, or a watch / weekly chip. Keywords
          search About and stored website scrape text.
        </div>
      ) : (
        <>
          {loadError ? (
            <div className="empty-state theme-load-error">{loadError}</div>
          ) : null}
          {loading && !data ? <div className="loading">Loading…</div> : null}
          <CompanyTable
            rows={data?.rows ?? []}
            sort={sort}
            dir={dir}
            onSort={onSort}
            showMatched={themeActive}
            capFilter={cap}
            onNoteChange={softReload}
            onScrapeDone={softReload}
            toolbar={
              <div className="pager">
                <span>
                  {data
                    ? `${start.toLocaleString()}–${end.toLocaleString()} of ${data.total.toLocaleString()}`
                    : loading
                      ? "Loading…"
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
            }
          />
        </>
      )}
    </div>
  );
}
