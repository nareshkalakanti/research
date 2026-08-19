"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { initials } from "@/lib/superstars/catalog";

type View = "consensus" | "portfolio";

type InvestorSummary = {
  name: string;
  short: string;
  curated: boolean;
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

export function InvestorsPanel() {
  const [view, setView] = useState<View>("consensus");
  const [investor, setInvestor] = useState<string | null>(null);
  const [change, setChange] = useState<string>("all");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [sort, setSort] = useState<SortKey>("value");
  const [dir, setDir] = useState<SortDir>("desc");
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
  }, [view, investor, change, qDebounced]);

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
    let total = 25;
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

  const curatedInvestors = useMemo(
    () => (data?.investors ?? []).filter((i) => i.curated),
    [data],
  );

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

  return (
    <div className="panel ss-panel">
      <div className="ss-hero">
        <div className="ss-hero-copy">
          <p className="ss-eyebrow">Ace portfolios · Trendlyne</p>
          <h2>Investors</h2>
          <p>
            Superstar holdings and consensus picks — scan refreshes all aces in
            parallel from Trendlyne.
          </p>
        </div>
        <div className="ss-hero-right">
          <div className="ss-hero-meta">
            <div className="ss-meta-pill">
              <span>As of</span>
              <strong>{formatFetched(stats?.fetched_at)}</strong>
            </div>
            <div className="ss-meta-pill">
              <span>Curated</span>
              <strong>{stats?.investors ?? "—"}</strong>
            </div>
          </div>
          <button
            type="button"
            className="btn-fill ss-scan-btn"
            disabled={scanning}
            onClick={() => void runScan()}
          >
            {scanning ? "Scanning…" : "Scan"}
          </button>
        </div>
      </div>

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

      <div className="ss-stats">
        <div className="ss-stat">
          <span className="ss-stat-label">Holdings</span>
          <strong>{stats?.total_holdings ?? "—"}</strong>
        </div>
        <div className="ss-stat">
          <span className="ss-stat-label">Symbols</span>
          <strong>{stats?.unique_symbols ?? "—"}</strong>
        </div>
        <div className="ss-stat accent">
          <span className="ss-stat-label">Consensus 2+</span>
          <strong>{stats?.consensus ?? "—"}</strong>
        </div>
        <div className="ss-stat ok">
          <span className="ss-stat-label">New</span>
          <strong>{stats?.new_picks ?? "—"}</strong>
        </div>
        <div className="ss-stat up">
          <span className="ss-stat-label">Increased</span>
          <strong>{stats?.increased ?? "—"}</strong>
        </div>
        <div className="ss-stat down">
          <span className="ss-stat-label">Decreased</span>
          <strong>{stats?.decreased ?? "—"}</strong>
        </div>
      </div>

      <div className="ss-toolbar">
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
            Portfolios
          </button>
        </div>

        <div className="ss-search">
          <input
            type="search"
            placeholder="Search ticker, company, investor…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search holdings"
          />
        </div>

        {(investor || view === "portfolio") && (
          <div className="ss-change-filters">
            {(["all", "new", "increased", "decreased"] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={change === c ? "on" : ""}
                onClick={() => setChange(c)}
              >
                {c === "all" ? "All" : c[0].toUpperCase() + c.slice(1)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ss-investor-rail" aria-label="Investors">
        <button
          type="button"
          className={`ss-inv-chip all ${!investor ? "on" : ""}`}
          onClick={() => setInvestor(null)}
        >
          <span className="ss-inv-avatar all">★</span>
          <span className="ss-inv-text">
            <span className="ss-inv-name">All aces</span>
            <span className="ss-inv-sub">
              {stats?.consensus ?? 0} consensus · {stats?.total_holdings ?? 0}{" "}
              holdings
            </span>
          </span>
        </button>
        {curatedInvestors.map((inv) => (
          <button
            key={inv.name}
            type="button"
            className={`ss-inv-chip ${investor === inv.name ? "on" : ""}`}
            onClick={() => {
              setInvestor(inv.name);
              setView("portfolio");
            }}
            title={inv.name}
          >
            <span className="ss-inv-avatar">{initials(inv.name)}</span>
            <span className="ss-inv-text">
              <span className="ss-inv-name">{inv.short}</span>
              <span className="ss-inv-sub">
                {inv.holdings}
                {inv.new_picks > 0 ? (
                  <>
                    {" · "}
                    <em className="new">{inv.new_picks} new</em>
                  </>
                ) : null}
                {inv.increased > 0 ? <> · {inv.increased}↑</> : null}
                {inv.decreased > 0 ? <> · {inv.decreased}↓</> : null}
              </span>
            </span>
          </button>
        ))}
      </div>

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
              <div className="ss-co">
                <span className="ss-ticker">{r.symbol}</span>
                <span className="ss-name">{r.company_name || r.symbol}</span>
              </div>
            </td>
            <td className="num ss-col-n">
              <span className="ss-n-badge">{r.investor_count}</span>
            </td>
            <td className="ss-col-investors">
              <div className="ss-tags">
                {r.investor_shorts.map((s) => (
                  <span key={s} className="ss-tag">
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
              <div className="ss-co">
                <span className="ss-ticker">{r.symbol}</span>
                <span className="ss-name">{r.company_name || r.symbol}</span>
              </div>
            </td>
            {showInvestor && (
              <td className="ss-col-investor">
                <span className="ss-tag">{r.investor_short}</span>
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
