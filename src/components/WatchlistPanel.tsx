"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listWatchedTickers,
  removeWatch,
  subscribeWatchlist,
} from "@/lib/user-watchlist";
import { WatchButton } from "@/components/WatchButton";
import { tradingviewUrl } from "@/lib/links";

type WatchRow = {
  ticker: string;
  company: string;
  market: string | null;
  price: number | null;
  market_cap_cr: number | null;
  sector: string | null;
};

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })} Cr`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function WatchlistPanel() {
  const [tickers, setTickers] = useState<string[]>([]);
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const refreshTickers = useCallback(() => {
    setTickers(listWatchedTickers());
  }, []);

  const loadRows = useCallback(async (list: string[]) => {
    if (!list.length) {
      setRows([]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/iq-master?tickers=${encodeURIComponent(list.join(","))}`,
      );
      const json = (await res.json()) as {
        ok?: boolean;
        rows?: WatchRow[];
        error?: string;
      };
      if (!res.ok || json.ok === false) {
        setError(json.error || "Failed to load watchlist");
        setRows([]);
        return;
      }
      const byTicker = new Map(
        (json.rows ?? []).map((r) => [r.ticker.toUpperCase(), r]),
      );
      // Keep user watch order; stub missing names
      setRows(
        list.map((t) => {
          const hit = byTicker.get(t);
          return (
            hit ?? {
              ticker: t,
              company: t,
              market: null,
              price: null,
              market_cap_cr: null,
              sector: null,
            }
          );
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refreshTickers();
    return subscribeWatchlist(refreshTickers);
  }, [refreshTickers]);

  useEffect(() => {
    void loadRows(tickers);
  }, [tickers, loadRows]);

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
    <section className="panel wl-panel wl-panel--simple">
      <header className="wl-simple-head">
        <div>
          <h1 className="wl-simple-title">Watchlist</h1>
          <p className="wl-simple-sub">
            Stocks you saved with <strong>+ Watch</strong>. Click ★ Saved to
            remove.
          </p>
        </div>
        <span className="wl-simple-count" role="status">
          {error
            ? error
            : busy
              ? "Loading…"
              : tickers.length === 0
                ? "Empty"
                : `${visible.length} of ${tickers.length}`}
        </span>
      </header>

      <div className="wl-simple-toolbar">
        <input
          className="miq-search"
          type="search"
          placeholder="Filter ticker or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={!tickers.length}
        />
      </div>

      {tickers.length === 0 ? (
        <p className="miq-empty-hint">
          Click <strong>+ Watch</strong> next to any stock on Scan or Concall.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table wl-simple-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Sec</th>
                <th className="num">MCap</th>
                <th className="num">Price</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const tv = tradingviewUrl(r.ticker, r.market || "NSE");
                return (
                  <tr key={r.ticker}>
                    <td className="col-name">
                      <div className="company-watch-cell">
                        <WatchButton ticker={r.ticker} />
                        <div className="company-watch-name">
                          <span className="company-name">{r.company}</span>
                          <span className="company-meta">
                            <span className="ticker">{r.ticker}</span>
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="col-sec">{r.sector || "—"}</td>
                    <td className="num col-mcap_cr">{fmtCr(r.market_cap_cr)}</td>
                    <td className="num col-price">{fmtPrice(r.price)}</td>
                    <td className="col-links">
                      <div className="link-row link-row--compact">
                        <a
                          className="link-chip"
                          href={tv}
                          target="_blank"
                          rel="noreferrer"
                        >
                          TV
                        </a>
                        <button
                          type="button"
                          className="link-chip wl-remove-chip"
                          title={`Remove ${r.ticker}`}
                          onClick={() => removeWatch(r.ticker)}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
