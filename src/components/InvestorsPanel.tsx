"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CapMarketFilters,
  CAP_TITLE,
  type CapFilter,
} from "@/components/CapMarketFilters";
import {
  initials,
  INVESTOR_TAG_LABELS,
  INVESTOR_TAG_TITLES,
  shortName,
  type InvestorTagId,
} from "@/lib/superstars/catalog";
import type { CapTier } from "@/lib/types";

type View = "consensus" | "portfolio";

type InvestorSummary = {
  name: string;
  short: string;
  curated: boolean;
  tags: InvestorTagId[];
  holdings: number;
  new_picks: number;
  increased: number;
  decreased: number;
};

type HoldingRow = {
  investor: string;
  investor_short: string;
  symbol: string;
  exchange: string;
  company_name: string | null;
  holding_percent: number | null;
  change_qtr: number | null;
  change_type: string | null;
  holding_value_cr: number | null;
  price: number | null;
  sector: string | null;
  market: string;
  cap_code: CapTier;
  is_sme: boolean;
  web: string | null;
  sc: string;
  tv: string;
};

type ActivityPart = {
  investor: string;
  investor_short: string;
  change_type: string;
  change_qtr: number | null;
  label: string;
};

type ConsensusRow = {
  symbol: string;
  company_name: string | null;
  exchange: string;
  sector: string | null;
  price: number | null;
  holding_percent: number | null;
  market: string;
  cap_code: CapTier;
  is_sme: boolean;
  investor_count: number;
  new_count: number;
  increased_count: number;
  investors: string[];
  investor_shorts: string[];
  activity: string;
  activity_parts?: ActivityPart[];
  combined_value_cr: number | null;
  web: string | null;
  sc: string;
  tv: string;
};

type Stats = {
  total_holdings: number;
  unique_symbols: number;
  investors: number;
  curated_investors: number;
  new_picks: number;
  increased: number;
  decreased: number;
  consensus: number;
  sme_symbols: number;
  cap_counts: Record<CapTier, number>;
  fetched_at: string | null;
};

type ApiResponse = {
  ok: boolean;
  error?: string;
  view?: View;
  stats?: Stats;
  investors?: InvestorSummary[];
  holdings?: HoldingRow[];
  consensus?: ConsensusRow[];
  sectors?: string[];
};

type SortKey = "holding_percent" | "value" | "price" | "sector" | "company";
type SortDir = "asc" | "desc";

type Progress = {
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
};

type ScanBatch = {
  ok: boolean;
  offset: number;
  limit: number;
  total: number;
  done: number;
  remaining: number;
  pct: number;
  fetched_at: string;
  batch: Array<{
    name: string;
    short: string;
    holdings: number;
    sources: number;
    error?: string;
  }>;
  holdings_saved: number;
  error?: string;
};

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100) return `₹${Math.round(n).toLocaleString("en-IN")} Cr`;
  return `₹${n.toFixed(1)} Cr`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="sort-idle">⇅</span>;
  return <span className="sort-active">{dir === "asc" ? "↑" : "↓"}</span>;
}

function SortTh({
  label,
  col,
  sort,
  dir,
  onSort,
  align = "left",
  className = "",
}: {
  label: string;
  col: SortKey;
  sort: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th className={[align === "right" ? "num" : "", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className={`th-btn${align === "right" ? " th-btn--end" : ""}`}
        onClick={() => onSort(col)}
      >
        {label}
        <SortIcon active={sort === col} dir={dir} />
      </button>
    </th>
  );
}

function cmpNum(a: number | null | undefined, b: number | null | undefined): number {
  const av = a != null && Number.isFinite(a) ? a : -Infinity;
  const bv = b != null && Number.isFinite(b) ? b : -Infinity;
  return av - bv;
}

function cmpStr(a: string | null | undefined, b: string | null | undefined): number {
  return (a || "").localeCompare(b || "", undefined, { sensitivity: "base" });
}

function changeClass(ct: string | null | undefined): string {
  const c = (ct ?? "").toLowerCase();
  if (c === "new") return "ss-chg new";
  if (c === "disclosed") return "ss-chg disclosed";
  if (c === "increased") return "ss-chg up";
  if (c === "decreased") return "ss-chg down";
  return "ss-chg flat";
}

function changeLabel(row: HoldingRow): string {
  const ct = (row.change_type ?? "").toLowerCase();
  if (ct === "new") return "NEW";
  if (ct === "disclosed") return "DISCLOSED";
  if (ct === "increased") {
    if (row.change_qtr != null) {
      return `↑${row.change_qtr >= 0 ? "+" : ""}${row.change_qtr.toFixed(2)}%`;
    }
    return "↑";
  }
  if (ct === "decreased") {
    if (row.change_qtr != null) return `↓${row.change_qtr.toFixed(2)}%`;
    return "↓";
  }
  return "—";
}

function formatFetched(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function LinksCell({
  web,
  sc,
  tv,
}: {
  web: string | null;
  sc: string;
  tv: string;
}) {
  return (
    <div className="link-row link-row--compact ss-links">
      {web ? (
        <a
          href={web}
          target="_blank"
          rel="noopener noreferrer"
          className="link-chip"
        >
          Web
        </a>
      ) : (
        <span className="link-chip disabled">Web</span>
      )}
      <a href={sc} target="_blank" rel="noopener noreferrer" className="link-chip">
        SC
      </a>
      <a href={tv} target="_blank" rel="noopener noreferrer" className="link-chip">
        TV
      </a>
    </div>
  );
}

function ActivityCell({
  parts,
  fallback,
}: {
  parts?: ActivityPart[];
  fallback: string;
}) {
  const list =
    parts && parts.length
      ? parts
      : fallback
          .split(" · ")
          .filter(Boolean)
          .map((label) => ({
            investor: label,
            investor_short: label,
            change_type: "unchanged",
            change_qtr: null as number | null,
            label,
          }));

  return (
    <div className="ss-activity-list">
      {list.map((p, idx) => {
        const ct = (p.change_type || "").toLowerCase();
        const badge =
          ct === "new"
            ? "NEW"
            : ct === "increased"
              ? p.change_qtr != null
                ? `↑${p.change_qtr >= 0 ? "+" : ""}${p.change_qtr.toFixed(2)}%`
                : "↑"
              : ct === "decreased"
                ? p.change_qtr != null
                  ? `↓${p.change_qtr.toFixed(2)}%`
                  : "↓"
                : "";
        return (
          <div key={`${p.investor}-${idx}`} className="ss-activity-row">
            <span className="ss-activity-name">{p.investor_short}</span>
            {badge ? (
              <span className={changeClass(ct)}>{badge}</span>
            ) : (
              <span className="ss-chg flat">—</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StockTags({
  cap_code,
  is_sme,
  market,
}: {
  cap_code: CapTier;
  is_sme: boolean;
  market: string;
}) {
  return (
    <span className="result-tags ss-stock-tags">
      {is_sme ? (
        <span className="result-tag tag-mkt-sme" title={`${market} listing`}>
          SME
        </span>
      ) : null}
      <span
        className={`result-tag tag-cap-${cap_code.toLowerCase()}`}
        title={CAP_TITLE[cap_code as CapFilter] ?? cap_code}
      >
        {cap_code}
      </span>
    </span>
  );
}

function CompanyCell({
  symbol,
  name,
  cap_code,
  is_sme,
  market,
}: {
  symbol: string;
  name: string | null;
  cap_code: CapTier;
  is_sme: boolean;
  market: string;
}) {
  return (
    <div className="ss-row-co">
      <span className="company-name">{name || symbol}</span>
      <span className="company-meta">
        <span className="ticker">{symbol}</span>
      </span>
      <StockTags cap_code={cap_code} is_sme={is_sme} market={market} />
    </div>
  );
}

function InvestorTags({ tags }: { tags: InvestorTagId[] }) {
  if (!tags.length) return null;
  return (
    <span className="chip-row ss-inv-tags">
      {tags.map((tag) => (
        <span
          key={tag}
          className={`chip tag-chip tag-inv-${tag}`}
          title={INVESTOR_TAG_TITLES[tag]}
        >
          {INVESTOR_TAG_LABELS[tag]}
        </span>
      ))}
    </span>
  );
}

export function InvestorsPanel() {
  const [view, setView] = useState<View>("consensus");
  const [investor, setInvestor] = useState<string | null>(null);
  const [change, setChange] = useState<string>("all");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [sort, setSort] = useState<SortKey>("value");
  const [dir, setDir] = useState<SortDir>("desc");
  const [cap, setCap] = useState<CapFilter>("All");
  const [sme, setSme] = useState(false);
  const [invQ, setInvQ] = useState("");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);

  const onSort = useCallback((key: SortKey) => {
    setSort((prev) => {
      if (prev === key) {
        setDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setDir(key === "sector" || key === "company" ? "asc" : "desc");
      return key;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        view: investor ? "portfolio" : view,
        curated: "1",
        limit: view === "consensus" && !investor ? "200" : "400",
      });
      if (investor) params.set("investor", investor);
      if (change !== "all" && (investor || view === "portfolio")) {
        params.set("change", change);
      }
      if (qDebounced) params.set("q", qDebounced);
      if (cap !== "All") params.set("cap", cap);
      if (sme) params.set("sme", "1");
      const res = await fetch(`/api/superstars?${params}`);
      const json = (await res.json()) as ApiResponse;
      setData(json);
    } catch (e) {
      setData({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [view, investor, change, qDebounced, cap, sme]);

  useEffect(() => {
    void load();
  }, [load]);

  const runScan = useCallback(async () => {
    setScanning(true);
    setProgress({
      pct: 2,
      label: "Starting scan",
      detail: "Trendlyne · portfolio pages · parallel batches",
    });

    let offset = 0;
    let totalSaved = 0;
    let total = 16;
    const batchSize = 5;

    try {
      while (true) {
        const res = await fetch("/api/superstars", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offset,
            limit: batchSize,
            includeFunds: true,
          }),
        });
        const json = (await res.json()) as ScanBatch;
        if (!json.ok) {
          setProgress({
            pct: json.pct ?? 0,
            label: "Scan failed",
            detail: json.error || "Unknown error",
            error: true,
            done: true,
          });
          break;
        }

        total = json.total;
        totalSaved += json.holdings_saved;
        const names = json.batch.map((b) => b.short).join(", ");
        const errs = json.batch.filter((b) => b.error).length;
        setProgress({
          pct: json.remaining <= 0 ? 100 : Math.min(96, json.pct),
          label: `Scanned ${json.done}/${json.total}`,
          detail: `${names || "—"} · +${json.holdings_saved} holdings${
            errs ? ` · ${errs} warn` : ""
          } · ${totalSaved} total saved`,
          done: json.remaining <= 0,
        });

        await load();

        if (json.remaining <= 0) break;
        offset = json.done;
        await new Promise((r) => setTimeout(r, 120));
      }

      setProgress((p) =>
        p?.error
          ? p
          : {
              pct: 100,
              label: "Scan complete",
              detail: `${totalSaved.toLocaleString("en-IN")} holdings across ${total} investors`,
              done: true,
            },
      );
    } catch (e) {
      setProgress({
        pct: 0,
        label: "Scan failed",
        detail: e instanceof Error ? e.message : String(e),
        error: true,
        done: true,
      });
    } finally {
      setScanning(false);
    }
  }, [load]);

  const curatedInvestors = useMemo(() => {
    const list = (data?.investors ?? []).filter((i) => i.curated);
    const needle = invQ.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (i) =>
        i.name.toLowerCase().includes(needle) ||
        i.short.toLowerCase().includes(needle),
    );
  }, [data, invQ]);

  const sortedHoldings = useMemo(() => {
    const rows = [...(data?.holdings ?? [])];
    const mul = dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      let c = 0;
      if (sort === "holding_percent") c = cmpNum(a.holding_percent, b.holding_percent);
      else if (sort === "value") c = cmpNum(a.holding_value_cr, b.holding_value_cr);
      else if (sort === "price") c = cmpNum(a.price, b.price);
      else if (sort === "sector") c = cmpStr(a.sector, b.sector);
      else c = cmpStr(a.company_name || a.symbol, b.company_name || b.symbol);
      return c * mul || cmpStr(a.symbol, b.symbol);
    });
    return rows;
  }, [data?.holdings, sort, dir]);

  const sortedConsensus = useMemo(() => {
    const rows = [...(data?.consensus ?? [])];
    const mul = dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      let c = 0;
      if (sort === "holding_percent") c = cmpNum(a.holding_percent, b.holding_percent);
      else if (sort === "value") c = cmpNum(a.combined_value_cr, b.combined_value_cr);
      else if (sort === "price") c = cmpNum(a.price, b.price);
      else if (sort === "sector") c = cmpStr(a.sector, b.sector);
      else c = cmpStr(a.company_name || a.symbol, b.company_name || b.symbol);
      return c * mul || cmpStr(a.symbol, b.symbol);
    });
    return rows;
  }, [data?.consensus, sort, dir]);

  const stats = data?.stats;
  const activeView: View = investor ? "portfolio" : view;

  const capCounts = useMemo(() => {
    const cc = stats?.cap_counts;
    if (!cc) return undefined;
    return {
      NC: cc.NC,
      TI: cc.TI,
      MIC: cc.MIC,
      SC: cc.SC,
      MC: cc.MC,
      LC: cc.LC,
    };
  }, [stats?.cap_counts]);

  const filtersActive = cap !== "All" || sme;
  const rowCount =
    activeView === "consensus" && !investor
      ? sortedConsensus.length
      : sortedHoldings.length;

  const clearFilters = useCallback(() => {
    setCap("All");
    setSme(false);
  }, []);

  return (
    <div className="panel ss-panel">
      <header className="ss-top">
        <div className="ss-top-copy">
          <p className="ss-eyebrow">Trendlyne · superstar portfolios</p>
          <h2>Ace investors</h2>
          <p className="ss-top-sub">
            {stats?.investors ?? "—"} aces · as of {formatFetched(stats?.fetched_at)}
          </p>
        </div>
        <button
          type="button"
          className="btn-fill ss-scan-btn"
          disabled={scanning}
          onClick={() => void runScan()}
        >
          {scanning ? "Scanning…" : "Scan all"}
        </button>
      </header>

      {progress && (
        <div
          className={`fill-progress ss-progress ${progress.error ? "is-error" : ""} ${
            progress.done ? "is-done" : ""
          }`}
          role="status"
        >
          <div className="fill-progress-meta">
            <span className="fill-progress-label">{progress.label}</span>
            <span className="fill-progress-pct">{progress.pct}%</span>
          </div>
          <div className="fill-progress-track">
            <div
              className="fill-progress-bar"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
          {progress.detail ? (
            <p className="fill-progress-detail">{progress.detail}</p>
          ) : null}
        </div>
      )}

      <div className="ss-kpis">
        <div className="ss-kpi">
          <span className="ss-kpi-label">Holdings</span>
          <strong>{stats?.total_holdings ?? "—"}</strong>
        </div>
        <div className="ss-kpi">
          <span className="ss-kpi-label">Symbols</span>
          <strong>{stats?.unique_symbols ?? "—"}</strong>
        </div>
        <div className="ss-kpi accent">
          <span className="ss-kpi-label">Consensus 2+</span>
          <strong>{stats?.consensus ?? "—"}</strong>
        </div>
        <button
          type="button"
          className={`ss-kpi ss-kpi-btn sme ${sme ? "on" : ""}`}
          onClick={() => setSme((v) => !v)}
          title="Filter SME listings"
        >
          <span className="ss-kpi-label">SME</span>
          <strong>{stats?.sme_symbols ?? "—"}</strong>
        </button>
        <div className="ss-kpi ok">
          <span className="ss-kpi-label">New</span>
          <strong>{stats?.new_picks ?? "—"}</strong>
        </div>
        <div className="ss-kpi up">
          <span className="ss-kpi-label">Increased</span>
          <strong>{stats?.increased ?? "—"}</strong>
        </div>
        <div className="ss-kpi down">
          <span className="ss-kpi-label">Decreased</span>
          <strong>{stats?.decreased ?? "—"}</strong>
        </div>
      </div>

      <div className="ss-layout">
        <aside className="ss-sidebar">
          <div className="ss-sidebar-head">
            <span className="chip-label">Aces</span>
            <span className="ss-sidebar-count">{curatedInvestors.length}</span>
          </div>
          <input
            type="search"
            className="ss-sidebar-search"
            placeholder="Filter aces…"
            value={invQ}
            onChange={(e) => setInvQ(e.target.value)}
            aria-label="Filter investors"
          />
          <nav className="ss-inv-list" aria-label="Investors">
            <button
              type="button"
              className={`ss-inv-item ${!investor ? "on" : ""}`}
              onClick={() => {
                setInvestor(null);
                setView("consensus");
              }}
            >
              <span className="ss-inv-item-name">All aces</span>
              <span className="ss-inv-item-meta">
                {stats?.consensus ?? 0} consensus · {stats?.total_holdings ?? 0}{" "}
                rows
              </span>
            </button>
            {curatedInvestors.map((inv) => (
              <button
                key={inv.name}
                type="button"
                className={`ss-inv-item ${investor === inv.name ? "on" : ""}`}
                onClick={() => {
                  setInvestor(inv.name);
                  setView("portfolio");
                }}
                title={inv.name}
              >
                <span className="ss-inv-item-row">
                  <span className="ss-inv-item-avatar">{initials(inv.name)}</span>
                  <span className="ss-inv-item-name">{inv.short}</span>
                </span>
                <InvestorTags tags={inv.tags} />
                <span className="ss-inv-item-meta">
                  {inv.holdings} holdings
                  {inv.new_picks > 0 ? (
                    <>
                      {" · "}
                      <em className="new">{inv.new_picks} new</em>
                    </>
                  ) : null}
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <div className="ss-main">
          <div className="filter-bar ss-filter-bar">
            <div className="filter-bar-main">
              <div className="ss-view-toggle" role="tablist" aria-label="View">
                <button
                  type="button"
                  role="tab"
                  className={!investor && view === "consensus" ? "on" : ""}
                  aria-selected={!investor && view === "consensus"}
                  onClick={() => {
                    setInvestor(null);
                    setView("consensus");
                  }}
                >
                  Consensus
                </button>
                <button
                  type="button"
                  role="tab"
                  className={investor || view === "portfolio" ? "on" : ""}
                  aria-selected={Boolean(investor) || view === "portfolio"}
                  onClick={() => setView("portfolio")}
                >
                  Holdings
                </button>
              </div>

              <span className="filter-sep" aria-hidden />

              <CapMarketFilters
                cap={cap}
                onCap={setCap}
                sme={sme}
                onSme={setSme}
                showSme
                inline
                capCounts={capCounts}
                smeCount={stats?.sme_symbols}
                allCount={stats?.unique_symbols}
              />

              {filtersActive ? (
                <button
                  type="button"
                  className="clear-filter"
                  onClick={clearFilters}
                  title="Clear cap and SME filters"
                >
                  Clear
                </button>
              ) : null}

              {(investor || view === "portfolio") && (
                <>
                  <span className="filter-sep" aria-hidden />
                  <div className="ss-change-filters">
                    {(["all", "new", "increased", "decreased"] as const).map(
                      (c) => (
                        <button
                          key={c}
                          type="button"
                          className={`chip signal-chip ${change === c ? "on" : ""}`}
                          onClick={() => setChange(c)}
                        >
                          {c === "all" ? "All" : c[0].toUpperCase() + c.slice(1)}
                        </button>
                      ),
                    )}
                  </div>
                </>
              )}

              <div className="ss-search grow">
                <input
                  type="search"
                  placeholder="Search ticker, company, sector…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="Search holdings"
                />
              </div>
            </div>
          </div>

          <p className="ss-result-meta">
            Showing {rowCount.toLocaleString("en-IN")} rows
            {investor ? ` · ${shortName(investor)}` : ""}
            {filtersActive ? " · filtered" : ""}
          </p>

          {data && !data.ok && (
            <div className="ss-banner err">{data.error || "Failed to load"}</div>
          )}

          <div className="ss-table-wrap table-card">
            {loading && !data ? (
              <div className="ss-empty">Loading investors…</div>
            ) : activeView === "consensus" && !investor ? (
              <ConsensusTable
                rows={sortedConsensus}
                loading={loading}
                sort={sort}
                dir={dir}
                onSort={onSort}
              />
            ) : (
              <PortfolioTable
                rows={sortedHoldings}
                loading={loading}
                showInvestor={!investor}
                sort={sort}
                dir={dir}
                onSort={onSort}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ConsensusTable({
  rows,
  loading,
  sort,
  dir,
  onSort,
}: {
  rows: ConsensusRow[];
  loading: boolean;
  sort: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  if (!rows.length) {
    return (
      <div className="ss-empty">
        {loading ? "Loading…" : "No consensus holdings (2+ investors)."}
      </div>
    );
  }
  return (
    <table className="data-table ss-table ss-table-consensus">
      <thead>
        <tr>
          <th className="num ss-col-rank">#</th>
          <SortTh
            label="Company"
            col="company"
            sort={sort}
            dir={dir}
            onSort={onSort}
            className="ss-col-company"
          />
          <th className="num ss-col-n">N</th>
          <th className="ss-col-investors">Investors</th>
          <th className="ss-col-activity">Activity</th>
          <SortTh
            label="Holding %"
            col="holding_percent"
            sort={sort}
            dir={dir}
            onSort={onSort}
            align="right"
            className="ss-col-pct"
          />
          <SortTh
            label="Value"
            col="value"
            sort={sort}
            dir={dir}
            onSort={onSort}
            align="right"
            className="ss-col-value"
          />
          <SortTh
            label="Price"
            col="price"
            sort={sort}
            dir={dir}
            onSort={onSort}
            align="right"
            className="ss-col-price"
          />
          <SortTh
            label="Sector"
            col="sector"
            sort={sort}
            dir={dir}
            onSort={onSort}
            className="ss-col-sector"
          />
          <th className="ss-col-links">Links</th>
        </tr>
      </thead>
      <tbody className={loading ? "is-loading" : undefined}>
        {rows.map((r, i) => (
          <tr key={r.symbol}>
            <td className="num muted ss-col-rank">{i + 1}</td>
            <td className="ss-col-company">
              <CompanyCell
                symbol={r.symbol}
                name={r.company_name}
                cap_code={r.cap_code}
                is_sme={r.is_sme}
                market={r.market}
              />
            </td>
            <td className="num ss-col-n">
              <span className="ss-n-badge">{r.investor_count}</span>
            </td>
            <td className="ss-col-investors">
              <div className="chip-row ss-table-tags">
                {r.investor_shorts.map((s) => (
                  <span key={s} className="chip tag-chip tag-inv-name">
                    {s}
                  </span>
                ))}
              </div>
            </td>
            <td className="ss-col-activity">
              <ActivityCell parts={r.activity_parts} fallback={r.activity} />
            </td>
            <td className="num ss-col-pct">{fmtPct(r.holding_percent)}</td>
            <td className="num ss-col-value">{fmtCr(r.combined_value_cr)}</td>
            <td className="num ss-col-price">{fmtPrice(r.price)}</td>
            <td className="muted ss-col-sector">{r.sector || "—"}</td>
            <td className="ss-col-links">
              <LinksCell web={r.web} sc={r.sc} tv={r.tv} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PortfolioTable({
  rows,
  loading,
  showInvestor,
  sort,
  dir,
  onSort,
}: {
  rows: HoldingRow[];
  loading: boolean;
  showInvestor: boolean;
  sort: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  if (!rows.length) {
    return (
      <div className="ss-empty">
        {loading ? "Loading…" : "No holdings for this filter."}
      </div>
    );
  }
  return (
    <table className="data-table ss-table ss-table-portfolio">
      <thead>
        <tr>
          <SortTh
            label="Company"
            col="company"
            sort={sort}
            dir={dir}
            onSort={onSort}
            className="ss-col-company"
          />
          {showInvestor && <th className="ss-col-investor">Investor</th>}
          <th className="ss-col-change">Change</th>
          <SortTh
            label="Holding %"
            col="holding_percent"
            sort={sort}
            dir={dir}
            onSort={onSort}
            align="right"
            className="ss-col-pct"
          />
          <SortTh
            label="Value"
            col="value"
            sort={sort}
            dir={dir}
            onSort={onSort}
            align="right"
            className="ss-col-value"
          />
          <SortTh
            label="Price"
            col="price"
            sort={sort}
            dir={dir}
            onSort={onSort}
            align="right"
            className="ss-col-price"
          />
          <SortTh
            label="Sector"
            col="sector"
            sort={sort}
            dir={dir}
            onSort={onSort}
            className="ss-col-sector"
          />
          <th className="ss-col-links">Links</th>
        </tr>
      </thead>
      <tbody className={loading ? "is-loading" : undefined}>
        {rows.map((r) => (
          <tr key={`${r.investor}-${r.symbol}-${r.exchange}`}>
            <td className="ss-col-company">
              <CompanyCell
                symbol={r.symbol}
                name={r.company_name}
                cap_code={r.cap_code}
                is_sme={r.is_sme}
                market={r.market}
              />
            </td>
            {showInvestor && (
              <td className="ss-col-investor">
                <span className="chip tag-chip tag-inv-name">{r.investor_short}</span>
              </td>
            )}
            <td className="ss-col-change">
              <span className={changeClass(r.change_type)}>
                {changeLabel(r)}
              </span>
            </td>
            <td className="num ss-col-pct">{fmtPct(r.holding_percent)}</td>
            <td className="num ss-col-value">{fmtCr(r.holding_value_cr)}</td>
            <td className="num ss-col-price">{fmtPrice(r.price)}</td>
            <td className="muted ss-col-sector">{r.sector || "—"}</td>
            <td className="ss-col-links">
              <LinksCell web={r.web} sc={r.sc} tv={r.tv} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
