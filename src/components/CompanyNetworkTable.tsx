"use client";

import { useEffect, useState, Fragment } from "react";
import { tradingviewUrl } from "@/lib/links";

type PairRow = {
  ticker_a: string;
  ticker_b: string;
  shared_directors: number;
  name_a: string | null;
  name_b: string | null;
};

type DirectorRow = {
  person_id: string;
  name: string;
  company_count: number;
  tickers: string[];
};

type ConnectivityRow = {
  ticker: string;
  name: string | null;
  market_cap_cr: number | null;
  cap_code: string;
  total_directors: number;
  externally_connected_directors: number;
  connected_share: number | null;
};

type CapBand = { code: string; label: string };

type DiscoveryRow = {
  target_ticker: string;
  target_company: string | null;
  person_id: string;
  director: string;
  connected_ticker: string;
  connected_company: string | null;
  target_market_cap: number | null;
  connected_market_cap: number | null;
  market_cap_ratio: number | null;
};

type NewConnRow = {
  target_ticker: string;
  target_company: string | null;
  target_market_cap: number | null;
  director: string;
  person_id: string;
  event_date: string;
  connected_ticker: string;
  connected_company: string | null;
  connected_market_cap: number | null;
  market_cap_ratio: number | null;
  connection_type: "same_group" | "cross_group" | "unclassified";
  board_count: number | null;
};

type NewConnTarget = {
  target_ticker: string;
  target_company: string | null;
  target_market_cap: number | null;
  connected_companies: number;
  n_10k: number;
  n_25k: number;
  n_50k: number;
  largest_connected_mcap: number | null;
  largest_connected_ticker: string | null;
  largest_connected_company: string | null;
  largest_ratio: number | null;
  cross_group_count: number;
  multi_board_director_count: number;
};

type NewConnSummary = {
  edges: number;
  unique_targets: number;
  unique_directors: number;
  cross_group: number;
  mega_connections: number;
};

type Mode = "connectivity" | "discovery" | "new" | "gap" | "pairs" | "directors";
type NewPane = "connections" | "anomalies";
type AnomalyKind = "gap" | "multi" | "cross" | "boards" | "large";

const GOVERNANCE_NETWORK_COVERAGE_NOTE =
  "Governance coverage: NSE / NSE SME network. BSE SME companies are included in the company universe and market-cap data but excluded from governance connections because reliable current board extraction is unavailable.";

const VIEW_BY_MODE: Record<Mode, string> = {
  connectivity: "company-connectivity",
  discovery: "network-discovery",
  new: "network-new-connections",
  gap: "network-new-connections",
  pairs: "company-network",
  directors: "director-network",
};

const NOUN_BY_MODE: Record<Mode, string> = {
  connectivity: "companies",
  discovery: "connections",
  new: "new connections",
  gap: "companies",
  pairs: "pairs",
  directors: "directors",
};

function fmtRatio(v: number | null): string {
  if (v == null) return "N/A";
  return `${v.toLocaleString("en-IN", { maximumFractionDigits: 1 })}x`;
}

function fmtCr(v: number | null): string {
  if (v == null) return "N/A";
  const digits = Math.abs(v) < 10 ? 2 : 0;
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: digits })} Cr`;
}

function fmtShare(v: number | null): string {
  if (v == null) return "N/A";
  return `${Math.round(v * 100)}%`;
}

function fmtEventDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function connLabel(v: NewConnRow["connection_type"]): string {
  if (v === "same_group") return "Same group";
  if (v === "cross_group") return "Cross group";
  return "Unclassified";
}

function anomalyBadges(row: NewConnRow): string[] {
  const badges: string[] = [];
  const ratio = row.market_cap_ratio ?? 0;
  const mcap = row.connected_market_cap ?? 0;
  const boards = row.board_count ?? 0;
  if (ratio >= 500) badges.push("500x+ GAP");
  else if (ratio >= 250) badges.push("250x+ GAP");
  else if (ratio >= 100) badges.push("100x+ GAP");
  else if (ratio >= 50) badges.push("50x+ GAP");
  else if (ratio >= 25) badges.push("25x+ GAP");
  else if (ratio >= 10) badges.push("10x+ GAP");
  if (mcap >= 50_000) badges.push("₹50kCr+");
  else if (mcap >= 25_000) badges.push("₹25kCr+");
  else if (mcap >= 10_000) badges.push("₹10kCr+");
  if (row.connection_type === "cross_group") badges.push("CROSS GROUP");
  if (boards >= 5) badges.push("5+ BOARDS");
  else if (boards >= 4) badges.push("4+ BOARDS");
  else if (boards >= 3) badges.push("3+ BOARDS");
  return badges;
}

export function CompanyNetworkTable({
  onPerson,
  chartUrl,
  onTargetTicker,
}: {
  onPerson: (personId: string, name: string) => void;
  chartUrl?: (ticker: string) => string;
  onTargetTicker?: (ticker: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("connectivity");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [caps, setCaps] = useState<string[] | null>(null);
  const [bands, setBands] = useState<CapBand[]>([]);
  const [pairs, setPairs] = useState<PairRow[]>([]);
  const [directors, setDirectors] = useState<DirectorRow[]>([]);
  const [companies, setCompanies] = useState<ConnectivityRow[]>([]);
  const [discovery, setDiscovery] = useState<DiscoveryRow[]>([]);
  const [news, setNews] = useState<NewConnRow[]>([]);
  const [targets, setTargets] = useState<NewConnTarget[]>([]);
  const [summary, setSummary] = useState<NewConnSummary | null>(null);
  const [days, setDays] = useState("180");
  const [connection, setConnection] = useState("any");
  const [minConnected, setMinConnected] = useState("0");
  const [minRatio, setMinRatio] = useState("0");
  const [maxTargetFilter, setMaxTargetFilter] = useState("5000");
  const [minBoards, setMinBoards] = useState("0");
  const [minN10k, setMinN10k] = useState("0");
  const [sort, setSort] = useState("event");
  const [newPane, setNewPane] = useState<NewPane>("connections");
  const [anomaly, setAnomaly] = useState<AnomalyKind>("gap");
  const [drillTicker, setDrillTicker] = useState<string | null>(null);
  const [profileRows, setProfileRows] = useState<NewConnRow[]>([]);
  const [maxTarget, setMaxTarget] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const capsKey = caps ? caps.join(",") : "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      view: VIEW_BY_MODE[mode],
      page: String(page),
      pageSize: "50",
    });
    if (q.trim()) params.set("q", q.trim());
    if (mode === "connectivity" && capsKey) params.set("caps", capsKey);
    if (mode === "new" || mode === "gap") {
      params.set("days", days);
      params.set("connection", mode === "gap" ? "any" : connection);
      params.set("minConnected", mode === "gap" ? "0" : minConnected);
      params.set("minRatio", mode === "gap" ? "0" : minRatio);
      params.set("maxTarget", maxTargetFilter);
      params.set("minBoards", mode === "gap" ? "0" : minBoards);
      params.set("sort", mode === "gap" ? "ratio" : sort);
      if (mode === "gap") {
        params.set("agg", "targets");
        params.set("minN10k", "0");
      } else if (newPane === "anomalies" && anomaly === "multi") {
        params.set("agg", "targets");
        params.set("minN10k", minN10k);
      }
    }
    void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as {
          rows?: unknown[];
          targets?: NewConnTarget[];
          total?: number;
          pages?: number;
          caps?: string[];
          bands?: CapBand[];
          max_target_mcap?: number | null;
          summary?: NewConnSummary;
        };
      })
      .then((json) => {
        if (cancelled) return;
        const rows = Array.isArray(json.rows) ? json.rows : [];
        if (mode === "pairs") setPairs(rows as PairRow[]);
        else if (mode === "directors") setDirectors(rows as DirectorRow[]);
        else if (mode === "discovery") {
          setDiscovery(rows as DiscoveryRow[]);
          setMaxTarget(json.max_target_mcap ?? null);
        } else if (mode === "new") {
          setNews(rows as NewConnRow[]);
          setTargets(Array.isArray(json.targets) ? json.targets : []);
          setSummary(json.summary ?? null);
          setMaxTarget(json.max_target_mcap ?? null);
        } else if (mode === "gap") {
          setNews([]);
          setTargets(Array.isArray(json.targets) ? json.targets : []);
          setSummary(json.summary ?? null);
          setMaxTarget(json.max_target_mcap ?? null);
        } else {
          setCompanies(rows as ConnectivityRow[]);
          if (json.bands) setBands(json.bands);
          if (!capsKey && json.caps) setCaps(json.caps);
        }
        setTotal(json.total ?? 0);
        setPages(json.pages ?? 1);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPairs([]);
        setDirectors([]);
        setCompanies([]);
        setDiscovery([]);
        setNews([]);
        setTargets([]);
        setSummary(null);
        setProfileRows([]);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    mode,
    q,
    page,
    capsKey,
    days,
    connection,
    minConnected,
    minRatio,
    maxTargetFilter,
    minBoards,
    minN10k,
    sort,
    newPane,
    anomaly,
  ]);

  useEffect(() => {
    if (mode !== "gap" || !drillTicker) {
      setProfileRows([]);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      view: "network-new-connections",
      page: "1",
      pageSize: "200",
      days,
      connection: "any",
      minConnected: "0",
      minRatio: "0",
      maxTarget: maxTargetFilter,
      minBoards: "0",
      sort: "ratio",
      targetTicker: drillTicker,
    });
    void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { rows?: NewConnRow[] };
      })
      .then((json) => {
        if (cancelled) return;
        setProfileRows(Array.isArray(json.rows) ? json.rows : []);
      })
      .catch(() => {
        if (!cancelled) setProfileRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, drillTicker, days, maxTargetFilter]);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setPage(1);
    setDrillTicker(null);
    setProfileRows([]);
    if (next !== "new") {
      setNewPane("connections");
    }
    if (next === "gap") {
      setDays("180");
      setConnection("any");
      setMinConnected("0");
      setMinRatio("0");
      setMaxTargetFilter("5000");
      setMinBoards("0");
      setMinN10k("0");
      setSort("ratio");
    }
  };

  const applyNewPane = (pane: NewPane) => {
    if (pane === newPane) return;
    setNewPane(pane);
    setPage(1);
    if (pane === "connections") {
      setDays("180");
      setConnection("any");
      setMinConnected("0");
      setMinRatio("0");
      setMaxTargetFilter("5000");
      setMinBoards("0");
      setMinN10k("0");
      setSort("event");
    } else {
      applyAnomalyKind(anomaly);
    }
  };

  const applyAnomalyKind = (kind: AnomalyKind) => {
    setAnomaly(kind);
    setPage(1);
    setMinN10k(kind === "multi" ? "2" : "0");
    if (kind === "gap") {
      setMinRatio((v) => (v === "0" ? "25" : v));
      setSort("ratio");
    } else if (kind === "cross") {
      setConnection("cross_group");
      setSort("ratio");
    } else if (kind === "boards") {
      setMinBoards((v) => (v === "0" ? "3" : v));
      setSort("boards");
    } else if (kind === "large") {
      setMinConnected((v) => (v === "0" ? "10000" : v));
      setSort("event");
    } else {
      setSort("event");
    }
  };

  const toggleCap = (code: string) => {
    const cur = caps ?? [];
    const next = cur.includes(code)
      ? cur.filter((c) => c !== code)
      : bands.map((b) => b.code).filter((c) => c === code || cur.includes(c));
    if (!next.length) return;
    setCaps(next);
    setPage(1);
  };

  const tvHref = (ticker: string) =>
    chartUrl?.(ticker) || tradingviewUrl(ticker);

  const targetCell = (ticker: string, name: string | null) => (
    <td className="net-company">
      {onTargetTicker ? (
        <button
          type="button"
          title={`${ticker} — board graph`}
          onClick={() => onTargetTicker(ticker)}
        >
          {ticker}
        </button>
      ) : (
        <a
          href={tvHref(ticker)}
          target="_blank"
          rel="noreferrer"
          title={`${ticker} — TradingView`}
        >
          {ticker}
        </a>
      )}
      {name ? <span>{name}</span> : null}
    </td>
  );

  const companyCell = (ticker: string, name: string | null) => {
    const href = tvHref(ticker);
    const title = `${ticker} — TradingView`;
    return (
      <td className="net-company">
        <a href={href} target="_blank" rel="noreferrer" title={title}>
          {ticker}
        </a>
        {name ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title={title}
            className="net-company-name"
          >
            {name}
          </a>
        ) : null}
      </td>
    );
  };

  const modeTab = (id: Mode, label: string) => (
    <button
      type="button"
      role="tab"
      className={mode === id ? "tab on" : "tab"}
      aria-selected={mode === id}
      onClick={() => switchMode(id)}
    >
      {label}
    </button>
  );

  return (
    <div className="company-network">
      <div className="company-network-bar">
        <div className="fam-dash-tabs" role="tablist" aria-label="Network">
          {modeTab("connectivity", "Connectivity")}
          {modeTab("discovery", "Discovery")}
          {modeTab("new", "New Connections")}
          {modeTab("gap", "Capital Gap")}
          {modeTab("pairs", "Company pairs")}
          {modeTab("directors", "Directors")}
        </div>
        <input
          value={q}
          placeholder={
            mode === "directors" || mode === "discovery" || mode === "new" || mode === "gap"
              ? "Director, ticker or company…"
              : "Ticker or company…"
          }
          onChange={(e) => {
            setPage(1);
            setQ(e.target.value);
          }}
        />
        <span className="table-meta">
          {loading
            ? "Loading…"
            : `${total.toLocaleString("en-IN")} ${
                mode === "new" && newPane === "anomalies" && anomaly === "multi"
                  ? "targets"
                  : NOUN_BY_MODE[mode]
              }`}
        </span>
      </div>
      {mode === "connectivity" ? (
        <>
          <div className="company-network-caps">
            {bands.map((b) => (
              <button
                key={b.code}
                type="button"
                className={caps?.includes(b.code) ? "on" : ""}
                aria-pressed={caps?.includes(b.code) ?? false}
                onClick={() => toggleCap(b.code)}
              >
                {b.label}
              </button>
            ))}
          </div>
          <p className="table-meta">
            Connected directors also sit on at least one other listed board,
            including boards in the same business group. More connectivity
            marks a company for network investigation, not a better investment.
          </p>
        </>
      ) : null}
      {mode === "discovery" ? (
        <p className="table-meta">
          Companies under {fmtCr(maxTarget)} linked through a director to
          another listed board. Market cap ratio = connected company market cap
          ÷ target market cap. It flags unusual size gaps for investigation; it
          is not a quality score.
        </p>
      ) : null}
      {mode === "directors" ? (
        <p className="table-meta">
          Directors on two or more listed boards. A high count is not good or
          bad; it marks people who connect companies.
        </p>
      ) : null}
      {mode === "gap" ? (
        <>
          <p className="table-meta">{GOVERNANCE_NETWORK_COVERAGE_NOTE}</p>
          <p className="table-meta">
            Company-level measurements on the same latest-join edges as New
            Connections. These are counts and ratios, not a network score.
            {maxTargetFilter !== "all"
              ? ` Target market cap < ₹${Number(maxTargetFilter).toLocaleString("en-IN")} Cr.`
              : ""}
          </p>
          <div className="company-network-filters">
            <label>
              Time
              <select
                value={days}
                onChange={(e) => {
                  setPage(1);
                  setDays(e.target.value);
                }}
              >
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="180">180 days</option>
                <option value="365">1 year</option>
                <option value="all">All</option>
              </select>
            </label>
            <label>
              Target MCap
              <select
                value={maxTargetFilter}
                onChange={(e) => {
                  setPage(1);
                  setMaxTargetFilter(e.target.value);
                }}
              >
                <option value="500">{"< ₹500 Cr"}</option>
                <option value="1000">{"< ₹1,000 Cr"}</option>
                <option value="2000">{"< ₹2,000 Cr"}</option>
                <option value="5000">{"< ₹5,000 Cr"}</option>
                <option value="all">All</option>
              </select>
            </label>
          </div>
        </>
      ) : null}
      {mode === "new" ? (
        <>
          <div className="fam-dash-tabs" role="tablist" aria-label="New connections">
            <button
              type="button"
              role="tab"
              className={newPane === "connections" ? "tab on" : "tab"}
              aria-selected={newPane === "connections"}
              onClick={() => applyNewPane("connections")}
            >
              Connections
            </button>
            <button
              type="button"
              role="tab"
              className={newPane === "anomalies" ? "tab on" : "tab"}
              aria-selected={newPane === "anomalies"}
              onClick={() => applyNewPane("anomalies")}
            >
              Anomalies
            </button>
          </div>
          <p className="table-meta">
            Same joined-event edges as Connections (latest join still seated,
            other current boards, target market cap &gt; 0
            {maxTargetFilter !== "all" ? ` and &lt; ₹${Number(maxTargetFilter).toLocaleString("en-IN")} Cr` : ""}
            ). Counts describe the network, not investment quality. Target opens
            that stock’s board graph; connected names open TradingView.
          </p>
          {newPane === "anomalies" ? (
            <div className="company-network-caps" role="tablist" aria-label="Anomaly">
              {(
                [
                  ["gap", "Capital gap"],
                  ["multi", "Multiple large"],
                  ["cross", "Cross-group"],
                  ["boards", "Multi-board"],
                  ["large", "New large-cap"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={anomaly === id ? "on" : ""}
                  aria-pressed={anomaly === id}
                  onClick={() => applyAnomalyKind(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="company-network-filters">
            <label>
              Time
              <select
                value={days}
                onChange={(e) => {
                  setPage(1);
                  setDays(e.target.value);
                }}
              >
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="180">180 days</option>
                <option value="365">1 year</option>
                <option value="all">All</option>
              </select>
            </label>
            <label>
              Target MCap
              <select
                value={maxTargetFilter}
                onChange={(e) => {
                  setPage(1);
                  setMaxTargetFilter(e.target.value);
                }}
              >
                <option value="500">{"< ₹500 Cr"}</option>
                <option value="1000">{"< ₹1,000 Cr"}</option>
                <option value="2000">{"< ₹2,000 Cr"}</option>
                <option value="5000">{"< ₹5,000 Cr"}</option>
                <option value="all">All</option>
              </select>
            </label>
            <label>
              Connection
              <select
                value={connection}
                onChange={(e) => {
                  setPage(1);
                  setConnection(e.target.value);
                }}
              >
                <option value="any">All</option>
                <option value="same_group">Same group</option>
                <option value="cross_group">Cross group</option>
                <option value="unclassified">Unclassified</option>
              </select>
            </label>
            <label>
              Min connected MCap
              <select
                value={minConnected}
                onChange={(e) => {
                  setPage(1);
                  setMinConnected(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="1000">₹1,000 Cr</option>
                <option value="5000">₹5,000 Cr</option>
                <option value="10000">₹10,000 Cr</option>
                <option value="25000">₹25,000 Cr</option>
                <option value="50000">₹50,000 Cr</option>
              </select>
            </label>
            <label>
              Min ratio
              <select
                value={minRatio}
                onChange={(e) => {
                  setPage(1);
                  setMinRatio(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="10">10x</option>
                <option value="25">25x</option>
                <option value="50">50x</option>
                <option value="100">100x</option>
                <option value="250">250x</option>
                <option value="500">500x</option>
              </select>
            </label>
            {newPane === "anomalies" ? (
              <label>
                Min boards
                <select
                  value={minBoards}
                  onChange={(e) => {
                    setPage(1);
                    setMinBoards(e.target.value);
                  }}
                >
                  <option value="0">Any</option>
                  <option value="3">3+</option>
                  <option value="4">4+</option>
                  <option value="5">5+</option>
                </select>
              </label>
            ) : null}
            {newPane === "anomalies" && anomaly === "multi" ? (
              <label>
                ≥ ₹10k Cr companies
                <select
                  value={minN10k}
                  onChange={(e) => {
                    setPage(1);
                    setMinN10k(e.target.value);
                  }}
                >
                  <option value="2">2+</option>
                  <option value="3">3+</option>
                </select>
              </label>
            ) : null}
          </div>
          {summary ? (
            <div className="company-network-summary">
              <span>
                <strong>{summary.edges.toLocaleString("en-IN")}</strong> edges
              </span>
              <span>
                <strong>{summary.unique_targets.toLocaleString("en-IN")}</strong>{" "}
                unique targets
              </span>
              <span>
                <strong>
                  {summary.unique_directors.toLocaleString("en-IN")}
                </strong>{" "}
                unique directors
              </span>
              <span>
                <strong>{summary.cross_group.toLocaleString("en-IN")}</strong>{" "}
                cross-group edges
              </span>
              <span>
                <strong>
                  {summary.mega_connections.toLocaleString("en-IN")}
                </strong>{" "}
                connected companies ≥ ₹50k Cr
              </span>
            </div>
          ) : null}
        </>
      ) : null}
      {error ? <div className="table-meta">Could not load: {error}</div> : null}
      <div className="table-wrap">
        {mode === "connectivity" ? (
          <table className="company-network-table company-network-table--conn">
            <thead>
              <tr>
                <th>Company</th>
                <th>Market cap</th>
                <th>Total directors</th>
                <th>Connected directors</th>
                <th>Connected share</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((row) => (
                <tr key={row.ticker}>
                  {companyCell(row.ticker, row.name)}
                  <td>{fmtCr(row.market_cap_cr)}</td>
                  <td>{row.total_directors}</td>
                  <td>{row.externally_connected_directors}</td>
                  <td>{fmtShare(row.connected_share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : mode === "discovery" ? (
          <table className="company-network-table company-network-table--disc">
            <thead>
              <tr>
                <th>Target</th>
                <th>Director</th>
                <th>Connected company</th>
                <th>Target market cap</th>
                <th>Connected market cap</th>
                <th>Market cap ratio</th>
              </tr>
            </thead>
            <tbody>
              {discovery.map((row) => (
                <tr
                  key={`${row.target_ticker}|${row.person_id}|${row.connected_ticker}`}
                >
                  {companyCell(row.target_ticker, row.target_company)}
                  <td>
                    <button
                      type="button"
                      onClick={() => onPerson(row.person_id, row.director)}
                    >
                      {row.director}
                    </button>
                  </td>
                  {companyCell(row.connected_ticker, row.connected_company)}
                  <td>{fmtCr(row.target_market_cap)}</td>
                  <td>{fmtCr(row.connected_market_cap)}</td>
                  <td className="net-ratio">{fmtRatio(row.market_cap_ratio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : mode === "gap" ? (
          <table className="company-network-table company-network-table--gap">
            <thead>
              <tr>
                <th>Company</th>
                <th>MCap</th>
                <th>Connected companies</th>
                <th>Max connected MCap</th>
                <th>Max ratio</th>
                <th>≥ ₹10k Cr</th>
                <th>≥ ₹25k Cr</th>
                <th>≥ ₹50k Cr</th>
                <th>Cross group</th>
                <th>Multi-board</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((row) => {
                const open = drillTicker === row.target_ticker;
                const maxName =
                  row.largest_connected_ticker ||
                  row.largest_connected_company ||
                  null;
                return (
                  <Fragment key={row.target_ticker}>
                    <tr key={row.target_ticker}>
                      <td className="net-company">
                        <button
                          type="button"
                          title="Capital gap profile"
                          onClick={() =>
                            setDrillTicker(open ? null : row.target_ticker)
                          }
                        >
                          {row.target_ticker}
                        </button>
                        {row.target_company ? (
                          <span>{row.target_company}</span>
                        ) : null}
                      </td>
                      <td>{fmtCr(row.target_market_cap)}</td>
                      <td>{row.connected_companies}</td>
                      <td>
                        {fmtCr(row.largest_connected_mcap)}
                        {maxName ? (
                          <span>
                            {row.largest_connected_ticker}
                            {row.largest_connected_company
                              ? ` · ${row.largest_connected_company}`
                              : ""}
                          </span>
                        ) : null}
                      </td>
                      <td className="net-ratio">
                        {fmtRatio(row.largest_ratio)}
                      </td>
                      <td>{row.n_10k}</td>
                      <td>{row.n_25k}</td>
                      <td>{row.n_50k}</td>
                      <td>{row.cross_group_count}</td>
                      <td>{row.multi_board_director_count}</td>
                    </tr>
                    {open ? (
                      <tr
                        key={`${row.target_ticker}|profile`}
                        className="net-gap-profile"
                      >
                        <td colSpan={10}>
                          <div className="net-gap-profile-inner">
                            <p className="table-meta">
                              Capital gap profile — director, connected company,
                              market cap, ratio, group.
                            </p>
                            <table className="company-network-table company-network-table--new">
                              <thead>
                                <tr>
                                  <th>Director</th>
                                  <th>Connected company</th>
                                  <th>MCap</th>
                                  <th>Ratio</th>
                                  <th>Group</th>
                                  <th>Boards</th>
                                </tr>
                              </thead>
                              <tbody>
                                {profileRows.map((edge) => (
                                  <tr
                                    key={`${edge.person_id}|${edge.connected_ticker}`}
                                  >
                                    <td>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          onPerson(edge.person_id, edge.director)
                                        }
                                      >
                                        {edge.director}
                                      </button>
                                    </td>
                                    {companyCell(
                                      edge.connected_ticker,
                                      edge.connected_company,
                                    )}
                                    <td>{fmtCr(edge.connected_market_cap)}</td>
                                    <td className="net-ratio">
                                      {fmtRatio(edge.market_cap_ratio)}
                                    </td>
                                    <td>{connLabel(edge.connection_type)}</td>
                                    <td>{edge.board_count ?? "N/A"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        ) : mode === "new" && newPane === "anomalies" && anomaly === "multi" ? (
          <table className="company-network-table company-network-table--new">
            <thead>
              <tr>
                <th>Target</th>
                <th>Target MCap</th>
                <th>Connected companies</th>
                <th>≥ ₹10k Cr</th>
                <th>≥ ₹25k Cr</th>
                <th>≥ ₹50k Cr</th>
                <th>Largest connected MCap</th>
                <th>Largest ratio</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((row) => (
                <tr key={row.target_ticker}>
                  <td className="net-company">
                    <button
                      type="button"
                      title="Show underlying connections"
                      onClick={() => {
                        setQ(row.target_ticker);
                        setAnomaly("gap");
                        setMinN10k("0");
                        setPage(1);
                      }}
                    >
                      {row.target_ticker}
                    </button>
                    {row.target_company ? <span>{row.target_company}</span> : null}
                  </td>
                  <td>{fmtCr(row.target_market_cap)}</td>
                  <td>{row.connected_companies}</td>
                  <td>{row.n_10k}</td>
                  <td>{row.n_25k}</td>
                  <td>{row.n_50k}</td>
                  <td>{fmtCr(row.largest_connected_mcap)}</td>
                  <td className="net-ratio">{fmtRatio(row.largest_ratio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : mode === "new" ? (
          <table className="company-network-table company-network-table--new">
            <thead>
              <tr>
                <th>Target</th>
                <th>Target MCap</th>
                <th>Director</th>
                {newPane === "anomalies" && anomaly === "boards" ? (
                  <th>Board count</th>
                ) : null}
                {newPane === "connections" || anomaly === "large" ? (
                  <th>Event date</th>
                ) : null}
                <th>Connected company</th>
                <th>Connected MCap</th>
                <th>Ratio</th>
                {newPane === "connections" ||
                anomaly === "gap" ||
                anomaly === "large" ? (
                  <th>Connection</th>
                ) : null}
                {newPane === "anomalies" ? <th>Flags</th> : null}
              </tr>
            </thead>
            <tbody>
              {news.map((row) => (
                <tr
                  key={`${row.target_ticker}|${row.person_id}|${row.connected_ticker}`}
                >
                  {targetCell(row.target_ticker, row.target_company)}
                  <td>{fmtCr(row.target_market_cap)}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => onPerson(row.person_id, row.director)}
                    >
                      {row.director}
                    </button>
                  </td>
                  {newPane === "anomalies" && anomaly === "boards" ? (
                    <td>{row.board_count ?? "N/A"}</td>
                  ) : null}
                  {newPane === "connections" || anomaly === "large" ? (
                    <td>{fmtEventDate(row.event_date)}</td>
                  ) : null}
                  {companyCell(row.connected_ticker, row.connected_company)}
                  <td>{fmtCr(row.connected_market_cap)}</td>
                  <td className="net-ratio">{fmtRatio(row.market_cap_ratio)}</td>
                  {newPane === "connections" ||
                  anomaly === "gap" ||
                  anomaly === "large" ? (
                    <td>{connLabel(row.connection_type)}</td>
                  ) : null}
                  {newPane === "anomalies" ? (
                    <td className="net-badges">
                      {anomalyBadges(row).map((b) => (
                        <span key={b} className="net-badge">
                          {b}
                        </span>
                      ))}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : mode === "pairs" ? (
          <table className="company-network-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Company</th>
                <th>Shared directors</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((row) => (
                <tr key={`${row.ticker_a}|${row.ticker_b}`}>
                  {companyCell(row.ticker_a, row.name_a)}
                  {companyCell(row.ticker_b, row.name_b)}
                  <td>{row.shared_directors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="company-network-table">
            <thead>
              <tr>
                <th>Director</th>
                <th>Boards</th>
                <th>Companies connected</th>
              </tr>
            </thead>
            <tbody>
              {directors.map((row) => (
                <tr key={row.person_id}>
                  <td>
                    <button
                      type="button"
                      onClick={() => onPerson(row.person_id, row.name)}
                    >
                      {row.name}
                    </button>
                    <span>{row.person_id}</span>
                  </td>
                  <td className="company-network-tickers">
                    {row.tickers.map((t) => (
                      <a
                        key={t}
                        href={tvHref(t)}
                        target="_blank"
                        rel="noreferrer"
                        title={`${t} — TradingView`}
                      >
                        {t}
                      </a>
                    ))}
                  </td>
                  <td>{row.company_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {pages > 1 ? (
        <div className="company-network-pager">
          <button
            type="button"
            className="btn-ghost"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span className="table-meta">
            {page} / {pages}
          </span>
          <button
            type="button"
            className="btn-ghost"
            disabled={page >= pages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
