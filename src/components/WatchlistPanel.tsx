"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listWatchedTickers,
  removeWatch,
  subscribeWatchlist,
} from "@/lib/user-watchlist";
import { WatchButton } from "@/components/WatchButton";
import { tradingviewUrl } from "@/lib/links";
import type { IqMasterRow } from "@/lib/iq-master";

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })} Cr`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function govClass(signal: string | null | undefined): string {
  const s = (signal || "none").toLowerCase().replace(/\s+/g, "-");
  return `wl-gov wl-gov-${s}`;
}

export function WatchlistPanel() {
  const [tickers, setTickers] = useState<string[]>([]);
  const [rows, setRows] = useState<IqMasterRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const refreshTickers = useCallback(() => {
    setTickers(listWatchedTickers());
  }, []);

  useEffect(() => {
    refreshTickers();
    return subscribeWatchlist(refreshTickers);
  }, [refreshTickers]);

  useEffect(() => {
    if (!tickers.length) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    void fetch(`/api/iq-master?tickers=${encodeURIComponent(tickers.join(","))}`)
      .then(async (res) => {
        const json = (await res.json()) as {
          ok?: boolean;
          rows?: IqMasterRow[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || json.ok === false) {
          setError(json.error || "Failed to load watchlist");
          setRows([]);
          return;
        }
        setRows(json.rows ?? []);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tickers]);

  const needle = q.trim().toLowerCase();
  const visible = !needle
    ? rows
    : rows.filter(
        (r) =>
          r.ticker.toLowerCase().includes(needle) ||
          r.company.toLowerCase().includes(needle) ||
          (r.sector || "").toLowerCase().includes(needle),
      );

  return (
    <section className="miq panel wl-panel">
      <header className="miq-head">
        <div>
          <h1 className="miq-title">Watchlist</h1>
          <p className="miq-sub">
            Names you pin with + Watch. Metrics and filings from your local DBs.
          </p>
        </div>
      </header>

      <div className="miq-toolbar">
        <input
          className="miq-search"
          type="search"
          placeholder="Filter ticker or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={!tickers.length}
        />
        <span className="miq-live" role="status">
          {error
            ? error
            : busy
              ? "Loading…"
              : tickers.length === 0
                ? "Empty"
                : `${visible.length} of ${tickers.length}`}
        </span>
      </div>

      {tickers.length === 0 ? (
        <p className="miq-empty-hint">
          Click <strong>+ Watch</strong> next to any stock in MarketIQ,
          OrderBookIQ, BoardRoomIQ, Scan, or Orders.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="miq-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Price</th>
                <th>MCap</th>
                <th>MarketIQ</th>
                <th>Orders</th>
                <th>Gov</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.ticker}>
                  <td className="miq-td-co">
                    <div className="company-watch-cell">
                      <WatchButton ticker={r.ticker} />
                      <a
                        className="miq-co-name"
                        href={tradingviewUrl(r.ticker, r.market || "NSE")}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r.company}
                      </a>
                    </div>
                    <div className="miq-co-meta">
                      <span>{r.ticker}</span>
                      {r.sector ? (
                        <>
                          <span className="miq-dot">·</span>
                          <span>{r.sector}</span>
                        </>
                      ) : null}
                    </div>
                  </td>
                  <td className="wl-num">{fmtPrice(r.price)}</td>
                  <td className="wl-num">{fmtCr(r.market_cap_cr)}</td>
                  <td className="miq-td-details">
                    {r.marketiq ? (
                      <>
                        <div className="miq-headline">{r.marketiq.headline}</div>
                        <div className="miq-co-meta">
                          {r.marketiq.sentiment}
                          {r.marketiq.impact != null
                            ? ` · impact ${r.marketiq.impact}`
                            : ""}
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="wl-num">
                    {r.orders
                      ? `${r.orders.order_count} · ${fmtCr(r.orders.total_order_value_cr)}`
                      : "—"}
                  </td>
                  <td>
                    <span className={govClass(r.governance.signal)}>
                      {r.governance.signal || "—"}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="clear-filter"
                      onClick={() => removeWatch(r.ticker)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
