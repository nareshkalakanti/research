"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
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
  gaps?: Record<string, number>;
  signals?: {
    bb: number;
    tq: number;
    hold?: number;
    distress?: number;
    edge?: number;
    note?: number;
  };
  session?: { bb: string | null; tq: string | null };
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
  const [filterBb, setFilterBb] = useState(false);
  const [filterTq, setFilterTq] = useState(false);
  const [filterHold, setFilterHold] = useState(false);
  const [filterEdge, setFilterEdge] = useState(false);
  const [filterNote, setFilterNote] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("sector");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ScanApi | null>(null);
  const [loading, setLoading] = useState(false);
  const [signalCounts, setSignalCounts] = useState<{
    bb: number;
    tq: number;
    hold: number;
    distress: number;
    edge: number;
    note: number;
  }>({
    bb: 0,
    tq: 0,
    hold: 0,
    distress: 0,
    edge: 0,
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
              hold?: number;
              distress?: number;
              edge?: number;
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
            bb: j.signals.bb ?? 0,
            tq: j.signals.tq ?? 0,
            hold: j.signals.hold ?? 0,
            distress: j.signals.distress ?? 0,
            edge: j.signals.edge ?? 0,
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
  }, [selected, debouncedCustom, market, cap, filterBb, filterTq, filterHold, filterEdge, filterNote]);

  const themeActive = selected.length > 0 || debouncedCustom.trim().length > 0;
  const signalActive =
    filterBb || filterTq || filterHold || filterEdge || filterNote;
  const capActive = cap !== "All";
  const active = themeActive || signalActive || capActive;
  const listMarket = market;

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      if (!active) {
        setData(null);
        return;
      }
      setLoading(true);
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
      if (filterBb) params.set("bb", "1");
      if (filterTq) params.set("tq", "1");
      if (filterHold) params.set("hold", "1");
      if (filterEdge) params.set("edge", "1");
      if (filterNote) params.set("note", "1");
      if (opts?.refresh) params.set("refresh", "1");
      try {
        const res = await fetch(`/api/companies?${params}`);
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
          throw new Error(`Request failed (${res.status})`);
        }
        setData(json);
        if (json.markets) setMarkets(json.markets);
        if (json.signals) {
          setSignalCounts({
            bb: json.signals.bb ?? 0,
            tq: json.signals.tq ?? 0,
            hold: json.signals.hold ?? 0,
            distress: json.signals.distress ?? 0,
            edge: json.signals.edge ?? 0,
            note: json.signals.note ?? 0,
          });
        }
      } finally {
        setLoading(false);
      }
    },
    [
      active,
      themeActive,
      selected,
      debouncedCustom,
      listMarket,
      cap,
      filterBb,
      filterTq,
      filterHold,
      filterEdge,
      filterNote,
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
  const bseCount = markets["BSE"] ?? 0;
  const bseSmeCount = markets["BSE SME"] ?? 0;
  const allCount = Object.values(markets).reduce((a, b) => a + b, 0);

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
            value={market}
            onChange={(e) => setMarket(e.target.value)}
          >
            <option value="NSE">NSE ({nseCount.toLocaleString() || "…"})</option>
            <option value="NSE SME">
              NSE SME ({smeCount.toLocaleString() || "…"})
            </option>
            <option value="BSE">BSE ({bseCount.toLocaleString() || "…"})</option>
            <option value="BSE SME">
              BSE SME ({bseSmeCount.toLocaleString() || "…"})
            </option>
            <option value="All">All ({allCount.toLocaleString() || "…"})</option>
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
        <ScanFilters
          cap={cap}
          onCap={setCap}
          bb={filterBb}
          tq={filterTq}
          hold={filterHold}
          edge={filterEdge}
          note={filterNote}
          onBb={setFilterBb}
          onTq={setFilterTq}
          onHold={setFilterHold}
          onEdge={setFilterEdge}
          onNote={setFilterNote}
          bbCount={data?.signals?.bb ?? signalCounts.bb}
          tqCount={data?.signals?.tq ?? signalCounts.tq}
          holdCount={data?.signals?.hold ?? signalCounts.hold}
          distressCount={data?.signals?.distress ?? signalCounts.distress}
          edgeCount={data?.signals?.edge ?? signalCounts.edge}
          noteCount={data?.signals?.note ?? signalCounts.note}
          bbDate={data?.session?.bb ?? null}
          tqDate={data?.session?.tq ?? null}
          market={listMarket}
          onDone={() => void load({ refresh: true })}
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
            onDone={() => void load({ refresh: true })}
          />
        </div>
      ) : null}

      {!active ? (
        <div className="empty-state">
          Select themes, cap band, keywords, or a watch / weekly chip. Use{" "}
          <strong>Scan</strong> to refresh BB/TQ.
        </div>
      ) : (
        <>
          {loading && !data ? <div className="loading">Loading…</div> : null}
          <CompanyTable
            rows={data?.rows ?? []}
            sort={sort}
            dir={dir}
            onSort={onSort}
            showMatched={themeActive}
            capFilter={cap}
            onNoteChange={() => void load({ refresh: true })}
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
