"use client";

import { useEffect, useState } from "react";

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

type Mode = "connectivity" | "discovery" | "pairs" | "directors";

const VIEW_BY_MODE: Record<Mode, string> = {
  connectivity: "company-connectivity",
  discovery: "network-discovery",
  pairs: "company-network",
  directors: "director-network",
};

const NOUN_BY_MODE: Record<Mode, string> = {
  connectivity: "companies",
  discovery: "connections",
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

export function CompanyNetworkTable({
  onTicker,
  onPerson,
}: {
  onTicker: (ticker: string) => void;
  onPerson: (personId: string, name: string) => void;
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
    void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as {
          rows?: unknown[];
          total?: number;
          pages?: number;
          caps?: string[];
          bands?: CapBand[];
          max_target_mcap?: number | null;
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
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, q, page, capsKey]);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setPage(1);
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

  const companyCell = (ticker: string, name: string | null) => (
    <td className="net-company">
      <button type="button" onClick={() => onTicker(ticker)}>
        {ticker}
      </button>
      {name ? <span>{name}</span> : null}
    </td>
  );

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
          {modeTab("pairs", "Company pairs")}
          {modeTab("directors", "Directors")}
        </div>
        <input
          value={q}
          placeholder={
            mode === "directors" || mode === "discovery"
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
            : `${total.toLocaleString("en-IN")} ${NOUN_BY_MODE[mode]}`}
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
                      <button key={t} type="button" onClick={() => onTicker(t)}>
                        {t}
                      </button>
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
