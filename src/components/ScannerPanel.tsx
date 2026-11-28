"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FilterBar,
  HoldingsIndustryCheck,
  MultiPick,
  Pick,
  ExchangeSeg,
  exchangeMatch,
  type ExchangeId,
} from "@/components/FilterBar";
import { Loading } from "@/components/Loading";
import { StockscansBar } from "@/components/StockscansBar";
import { napkinUrl, tradingviewUrl, websiteUrl } from "@/lib/links";
import type { ScanConfig, ScannerData, ScanRow } from "@/lib/scanner";

/** Scanner: every stock with Name, Sector and Industry first; filters, column tabs. */

type ColKey = "sector" | "industry" | "mcap" | "price" | "chg" | "pe" | "roce" | "roe" | "sales_yoy" | "profit_yoy";
type Col = { key: ColKey; label: string; num?: boolean; fmt?: (r: ScanRow) => string };

const n0 = (v: number | null) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 0 }));
const n2 = (v: number | null) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const pct = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`);

const COLS: Record<ColKey, Col> = {
  sector: { key: "sector", label: "Sector" },
  industry: { key: "industry", label: "Industry" },
  mcap: { key: "mcap", label: "Market cap (₹ Cr)", num: true, fmt: (r) => n0(r.mcap) },
  price: { key: "price", label: "Close price (₹)", num: true, fmt: (r) => n2(r.price) },
  chg: { key: "chg", label: "Change", num: true, fmt: (r) => pct(r.chg) },
  pe: { key: "pe", label: "P/E", num: true, fmt: (r) => (r.pe == null ? "—" : r.pe.toFixed(1)) },
  roce: { key: "roce", label: "ROCE", num: true, fmt: (r) => pct(r.roce).replace("+", "") },
  roe: { key: "roe", label: "ROE", num: true, fmt: (r) => pct(r.roe).replace("+", "") },
  sales_yoy: { key: "sales_yoy", label: "Sales YoY", num: true, fmt: (r) => pct(r.sales_yoy) },
  profit_yoy: { key: "profit_yoy", label: "Profit YoY", num: true, fmt: (r) => pct(r.profit_yoy) },
};

/** Name, Sector and Industry lead every tab. */
const TABS: Array<{ id: string; label: string; cols: ColKey[] }> = [
  { id: "default", label: "Default", cols: ["sector", "industry", "mcap", "price"] },
  { id: "performance", label: "Performance", cols: ["sector", "industry", "price", "chg", "mcap"] },
  { id: "valuation", label: "Valuation", cols: ["sector", "industry", "mcap", "pe", "price"] },
  { id: "growth", label: "Growth", cols: ["sector", "industry", "sales_yoy", "profit_yoy", "mcap"] },
  { id: "ratios", label: "Ratios", cols: ["sector", "industry", "roce", "roe", "pe"] },
];

const EMPTY: ScanConfig = {
  conditions: [],
  sectors: [],
  industries: [],
  index: "all",
  exchange: "all",
  type: "all",
  list: "all",
  tab: "default",
  sort: { key: "mcap", dir: "desc" },
};
const PAGE = 50;

function numOf(r: ScanRow, k: ColKey): number | null {
  const v = r[k as keyof ScanRow];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ScannerPanel() {
  const [data, setData] = useState<ScannerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<ScanConfig>(EMPTY);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    try {
      const a = await fetch("/api/scanner", { cache: "no-store" }).then((r) => r.json());
      if (!a.ok) throw new Error(a.error || "Could not load stocks");
      setData(a as ScannerData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const update = (patch: Partial<ScanConfig>) => {
    setCfg((c) => ({ ...c, ...patch }));
    setPage(0);
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const secs = new Set(cfg.sectors ?? []);
    const inds = new Set(cfg.industries);
    const out = data.rows.filter((r) => {
      if (secs.size && !secs.has(r.sector ?? "")) return false;
      if (inds.size && !inds.has(r.industry ?? "")) return false;
      if (cfg.index !== "all" && !r.idx.includes(cfg.index)) return false;
      // Exchange: All / NSE / NSE SME / BSE / BSE SME (older saved scans used nse/bse + type).
      if (cfg.exchange === "nse" || cfg.exchange === "bse") {
        if ((r.market.startsWith("BSE") ? "bse" : "nse") !== cfg.exchange) return false;
        if (cfg.type !== "all" && (/SME/.test(r.market) ? "sme" : "main") !== cfg.type) return false;
      } else if (!exchangeMatch(r.market, cfg.exchange as ExchangeId)) return false;
      if (cfg.list !== "all" && !r.lists.includes(cfg.list)) return false;
      for (const c of cfg.conditions) {
        const v = numOf(r, c.field as ColKey);
        if (v == null) return false;
        if (c.op === ">" && !(v > c.a)) return false;
        if (c.op === "<" && !(v < c.a)) return false;
        if (c.op === "between" && !(v >= c.a && v <= (c.b ?? c.a))) return false;
      }
      if (needle && !r.name.toLowerCase().includes(needle) && !r.t.toLowerCase().includes(needle)) return false;
      return true;
    });
    const { key, dir } = cfg.sort;
    const sgn = dir === "asc" ? 1 : -1;
    return out.sort((a, b) => {
      if (key === "name") return sgn * a.name.localeCompare(b.name);
      if (key === "sector") return sgn * (a.sector ?? "").localeCompare(b.sector ?? "");
      if (key === "industry") return sgn * (a.industry ?? "").localeCompare(b.industry ?? "");
      const x = numOf(a, key as ColKey);
      const y = numOf(b, key as ColKey);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return sgn * (x - y);
    });
  }, [data, cfg, q]);

  const sectors = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data?.rows ?? []) if (r.sector) m.set(r.sector, (m.get(r.sector) ?? 0) + 1);
    return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([id, count]) => ({ id, label: id, count }));
  }, [data]);

  const industries = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data?.rows ?? []) if (r.industry) m.set(r.industry, (m.get(r.industry) ?? 0) + 1);
    return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([id, count]) => ({ id, label: id, count }));
  }, [data]);

  const sortBy = (key: string) =>
    update({
      sort: {
        key,
        dir:
          cfg.sort.key === key && cfg.sort.dir === "desc"
            ? "asc"
            : cfg.sort.key === key
              ? "desc"
              : key === "name" || key === "sector" || key === "industry"
                ? "asc"
                : "desc",
      },
    });

  const download = () => {
    const head = ["Ticker", "Name", "Exchange", "Sector", "Industry", "Market cap (Cr)", "Close price", "Change %", "P/E", "ROCE %", "ROE %", "Sales YoY %", "Profit YoY %"];
    const lines = [head.join(",")].concat(
      filtered.map((r) =>
        [r.t, r.name, r.market, r.sector, r.industry, r.mcap, r.price, r.chg, r.pe, r.roce, r.roe, r.sales_yoy, r.profit_yoy].map(csvCell).join(","),
      ),
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "stocks-scan.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (error && !data) return <div className="table-meta">Could not load: {error}</div>;
  if (!data) return <Loading label="Loading every stock" variant="block" />;

  const tab = TABS.find((t) => t.id === cfg.tab) ?? TABS[0]!;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const shown = filtered.slice(cur * PAGE, cur * PAGE + PAGE);
  const arrow = (k: string) => (cfg.sort.key === k ? (cfg.sort.dir === "desc" ? " ↓" : " ↑") : "");

  return (
    <section className="nano-section sc-panel">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">Every listed stock, with prices, ratios, sector and industry · StockScans</span>
          <h2 className="vx-title">Stocks scan</h2>
        </div>
      </header>
      <StockscansBar onDone={() => void load()} />

      <FilterBar>
        <MultiPick
          label="Sector"
          allLabel="All sectors"
          values={cfg.sectors ?? []}
          onChange={(v) => update({ sectors: v })}
          options={sectors}
          searchable
        />
        <MultiPick
          label="Industry"
          allLabel="All industries"
          values={cfg.industries}
          onChange={(v) => update({ industries: v })}
          options={industries}
          searchable
        />
        <HoldingsIndustryCheck
          values={cfg.industries}
          onChange={(v) => update({ industries: v })}
          available={industries.map((i) => i.id)}
        />
        <Pick
          label="Index"
          value={cfg.index}
          onChange={(v) => update({ index: v })}
          options={[{ id: "all", label: "All" }, ...data.indices.map((i) => ({ id: i.id, label: i.label, count: i.count }))]}
        />
        <ExchangeSeg
          value={(["all", "NSE", "NSE SME", "BSE", "BSE SME"].includes(cfg.exchange) ? cfg.exchange : "all") as ExchangeId}
          onChange={(v) => update({ exchange: v, type: "all" })}
          markets={data.rows.map((r) => r.market)}
        />
        <Pick
          label="Watchlist"
          value={cfg.list}
          onChange={(v) => update({ list: v })}
          options={[{ id: "all", label: "Any" }, ...data.lists.map((l) => ({ id: l.key, label: l.label, count: l.count }))]}
        />
      </FilterBar>

      <div className="sc-tabs" role="tablist" aria-label="Columns">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={cfg.tab === t.id} className={cfg.tab === t.id ? "on" : ""} onClick={() => update({ tab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="sc-bar">
        <input className="sc-search" placeholder="Search name or ticker" value={q} onChange={(e) => {
          setQ(e.target.value);
          setPage(0);
        }} aria-label="Search stocks" />
        <span className="sl-sub-inline">
          Showing {filtered.length ? cur * PAGE + 1 : 0}–{Math.min(filtered.length, cur * PAGE + PAGE)} of{" "}
          <strong>{filtered.length.toLocaleString("en-IN")}</strong>
        </span>
        <span className="fb-spacer" />
        <button type="button" className="btn-ghost" onClick={download} disabled={!filtered.length}>
          ↓ Download
        </button>
      </div>

      <div className="table-wrap nano-wrap">
        <table className="data-table nano-table sc-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th className="nano-col-name">
                <button type="button" className="sc-sort" onClick={() => sortBy("name")}>
                  Name{arrow("name")}
                </button>
              </th>
              {tab.cols.map((k) => (
                <th key={k} className={COLS[k].num ? "num" : ""}>
                  <button type="button" className="sc-sort" onClick={() => sortBy(k)}>
                    {COLS[k].label}
                    {arrow(k)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r.t}>
                <td className="num">{cur * PAGE + i + 1}</td>
                <td className="nano-col-name">
                  <a className="nano-name" href={tradingviewUrl(r.t, r.market)} target="_blank" rel="noreferrer">
                    {r.name}
                  </a>
                  <span className="nano-meta">
                    {r.t}
                    {r.market !== "NSE" ? <span>· {r.market}</span> : null}
                    <a className="np-chip" href={napkinUrl(r.t)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                      NP
                    </a>
                    {websiteUrl(r.web) ? (
                      <a className="np-chip" href={websiteUrl(r.web)!} target="_blank" rel="noopener noreferrer" title={r.web ?? ""}>
                        Web
                      </a>
                    ) : null}
                  </span>
                </td>
                {tab.cols.map((k) =>
                  k === "sector" || k === "industry" ? (
                    <td key={k} className="sc-ind">
                      <span
                        title={
                          r.ind_src === "stockscans"
                            ? `${k === "sector" ? "Sector" : "Industry"} from StockScans`
                            : "From the app's own classification"
                        }
                      >
                        {(k === "sector" ? r.sector : r.industry) ?? "—"}
                      </span>
                    </td>
                  ) : (
                    <td key={k} className={`num${k === "chg" && r.chg != null ? (r.chg >= 0 ? " sc-up" : " sc-down") : ""}`}>
                      {COLS[k].fmt!(r)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!filtered.length ? <p className="miq-empty-hint">No stocks match these filters.</p> : null}
      {pages > 1 ? (
        <div className="sc-pager">
          <button type="button" className="btn-ghost" disabled={cur === 0} onClick={() => setPage(cur - 1)}>
            ← Prev
          </button>
          <span className="sl-sub-inline">
            Page {cur + 1} of {pages}
          </span>
          <button type="button" className="btn-ghost" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>
            Next →
          </button>
        </div>
      ) : null}
      <p className="table-meta">
        Prices as of {data.as_of ? new Date(data.as_of).toLocaleString("en-IN") : "—"} · Sector › industry from StockScans for{" "}
        {data.rows.filter((r) => r.ind_src === "stockscans").length.toLocaleString("en-IN")} stocks, the app&apos;s own
        classification for the rest — every stock has one.
      </p>
    </section>
  );
}
