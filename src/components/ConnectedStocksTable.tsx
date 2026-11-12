"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export type ConnectedStockHubRow = {
  ticker: string;
  name: string | null;
  market_cap_cr: number | null;
  cap_code: string | null;
  linked_cos: number;
  directors: number;
  linked: string[];
};

type CapBand = "lc" | "mc" | "sc" | "sub500";

const CAP_FILTERS: Array<{ id: CapBand | "all"; label: string; cls: string }> = [
  { id: "all", label: "All caps", cls: "tag-cap-all" },
  { id: "lc", label: "Large", cls: "tag-cap-lc" },
  { id: "mc", label: "Mid", cls: "tag-cap-mc" },
  { id: "sc", label: "Small", cls: "tag-cap-sc" },
  { id: "sub500", label: "Under ₹500 Cr", cls: "tag-cap-mic" },
];

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 10_000) return `₹${(n / 1000).toFixed(1)}k Cr`;
  return `₹${Math.round(n).toLocaleString("en-IN")} Cr`;
}

function capBand(
  cap_code?: string | null,
  market_cap_cr?: number | null,
): CapBand | null {
  const mcap = market_cap_cr == null ? null : Number(market_cap_cr);
  if (mcap != null && Number.isFinite(mcap) && mcap > 0 && mcap < 500) {
    return "sub500";
  }
  const cap = (cap_code || "").toLowerCase();
  if (cap === "ti" || cap === "mic") return "sub500";
  if (cap === "lc" || cap === "mc" || cap === "sc") return cap;
  if (mcap == null || !Number.isFinite(mcap) || mcap <= 0) return null;
  if (mcap >= 20_000) return "lc";
  if (mcap >= 5_000) return "mc";
  return "sc";
}

function capLabel(band: CapBand | null): string {
  if (band === "lc") return "Large";
  if (band === "mc") return "Mid";
  if (band === "sc") return "Small";
  if (band === "sub500") return "<₹500 Cr";
  return "—";
}

/** Ranked hubs: stocks with shared-director links to other listed boards. */
export function ConnectedStocksTable({
  chartUrl,
  onTicker,
}: {
  chartUrl?: (ticker: string) => string;
  onTicker?: (ticker: string) => void;
}) {
  const [rows, setRows] = useState<ConnectedStockHubRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minLinked, setMinLinked] = useState(2);
  const [cap, setCap] = useState<CapBand | "all">("all");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setQDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async (opts?: { soft?: boolean }) => {
      if (!opts?.soft) setLoading(true);
      setError(null);
      try {
        const sp = new URLSearchParams({
          view: "connected-stocks",
          // Full hub list (~1.5k at min 2); search still narrows server-side.
          pageSize: "5000",
          minLinked: String(minLinked),
        });
        if (qDebounced) sp.set("q", qDebounced);
        const res = await fetch(`/api/governance-map?${sp}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          rows?: ConnectedStockHubRow[];
          total?: number;
        };
        setRows(Array.isArray(data.rows) ? data.rows : []);
        setTotal(typeof data.total === "number" ? data.total : 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
        if (!opts?.soft) {
          setRows([]);
          setTotal(0);
        }
      } finally {
        setLoading(false);
      }
    },
    [minLinked, qDebounced],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      const band = capBand(r.cap_code, r.market_cap_cr);
      if (cap !== "all" && band !== cap) return false;
      return true;
    });
  }, [rows, cap]);

  if (loading && !rows.length) {
    return <div className="table-meta">Loading connected stocks…</div>;
  }

  return (
    <div className="outside-commons">
      <div className="outside-commons-bar">
        <input
          className="fam-dash-search outside-commons-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ticker or company…"
          aria-label="Filter connected stocks"
        />
        <label className="outside-commons-min">
          Min linked
          <select
            value={minLinked}
            onChange={(e) => setMinLinked(Number(e.target.value) || 2)}
            aria-label="Minimum linked boards"
          >
            {[1, 2, 3, 4, 5, 8, 10].map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
          </select>
        </label>
        <span className="outside-commons-count">
          {filtered.length}
          <span>
            {" "}
            stocks{total > filtered.length ? ` · ${total} hubs` : ""}
          </span>
        </span>
      </div>

      <div className="outside-commons-caps" role="group" aria-label="Market cap">
        {CAP_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`result-tag ${f.cls}${cap === f.id ? " on" : ""}`}
            aria-pressed={cap === f.id}
            onClick={() => setCap(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? <div className="table-meta">Could not load: {error}</div> : null}

      {!filtered.length ? (
        <p className="miq-empty-hint">
          No matches. Loosen min linked or market-cap filter.
        </p>
      ) : (
        <div className="table-wrap outside-commons-wrap">
          <table className="data-table outside-commons-table">
            <thead>
              <tr>
                <th className="num col-rank">#</th>
                <th className="col-name">Company</th>
                <th className="num col-groups" title="Other listed boards sharing ≥1 director">
                  Linked
                </th>
                <th className="col-cap">Cap</th>
                <th className="num col-mcap_cr">MCap</th>
                <th
                  className="col-houses"
                  title="Sample connected tickers (strongest shared-director links)"
                >
                  Connected boards
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const tv = chartUrl?.(r.ticker);
                const band = capBand(r.cap_code, r.market_cap_cr);
                const expanded = open === r.ticker;
                const shown = expanded ? r.linked : r.linked.slice(0, 5);
                const name = (r.name || r.ticker).trim() || r.ticker;
                return (
                  <tr key={r.ticker}>
                    <td className="num col-rank">{i + 1}</td>
                    <td className="col-name">
                      <div className="outside-commons-name">
                        {tv ? (
                          <a
                            className="outside-commons-title"
                            href={tv}
                            target="_blank"
                            rel="noreferrer"
                            title={`Open ${r.ticker} on TradingView`}
                          >
                            {name}
                          </a>
                        ) : (
                          <button
                            type="button"
                            className="outside-commons-title"
                            onClick={() => onTicker?.(r.ticker)}
                          >
                            {name}
                          </button>
                        )}
                        <button
                          type="button"
                          className="outside-commons-ticker"
                          onClick={() => onTicker?.(r.ticker)}
                          title="Open hub + connected boards map"
                        >
                          {r.ticker}
                        </button>
                      </div>
                    </td>
                    <td className="num col-groups">
                      <span className="outside-commons-badge">{r.linked_cos}</span>
                    </td>
                    <td className="col-cap">
                      {band ? (
                        <span className={`result-tag tag-cap-${band}`}>
                          {capLabel(band)}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num col-mcap_cr">{fmtCr(r.market_cap_cr)}</td>
                    <td className="col-houses">
                      <div className="outside-commons-houses">
                        {shown.map((t) => (
                          <button
                            key={t}
                            type="button"
                            className="outside-commons-house"
                            onClick={() => onTicker?.(t)}
                            title={`Open ${t} board map`}
                          >
                            {t}
                          </button>
                        ))}
                        {r.linked_cos > shown.length ||
                        (!expanded && r.linked.length > 5) ? (
                          <button
                            type="button"
                            className="outside-commons-more"
                            onClick={() =>
                              setOpen(expanded ? null : r.ticker)
                            }
                          >
                            {expanded
                              ? "Less"
                              : `+${Math.max(0, r.linked_cos - shown.length)}`}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
