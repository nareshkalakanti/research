"use client";

import { useCallback, useEffect, useState } from "react";
import { tradingviewUrl } from "@/lib/links";
import { crossedAbove200Dma } from "@/lib/dma200-cross";

type DashRow = {
  ticker: string;
  company: string;
  market: string | null;
  price: number | null;
  market_cap_cr: number | null;
  sector: string | null;
};

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })} Cr`;
}

async function loadIqRows(syms: string[]): Promise<DashRow[]> {
  const CHUNK = 40;
  const collected: DashRow[] = [];
  for (let i = 0; i < syms.length; i += CHUNK) {
    const chunk = syms.slice(i, i + CHUNK);
    const res = await fetch(
      `/api/iq-master?tickers=${encodeURIComponent(chunk.join(","))}`,
    );
    const json = (await res.json()) as { ok?: boolean; rows?: DashRow[] };
    collected.push(...(json.rows ?? []));
  }
  const byTicker = new Map(collected.map((r) => [r.ticker.toUpperCase(), r]));
  return syms.map((t) => {
    const hit = byTicker.get(t.toUpperCase());
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
  });
}

async function loadCrossed200Dma(rows: DashRow[]): Promise<Set<string>> {
  const hits = new Set<string>();
  const CHUNK = 8;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (row) => {
        try {
          const q = new URLSearchParams({ ticker: row.ticker });
          if (row.market) q.set("market", row.market);
          const res = await fetch(`/api/quote-tape?${q}`, {
            signal: AbortSignal.timeout(30_000),
          });
          const json = (await res.json()) as {
            ok?: boolean;
            tape?: {
              price: number | null;
              dma200: number | null;
              prev_close: number | null;
            };
          };
          if (json.ok && crossedAbove200Dma(json.tape ?? null)) {
            hits.add(row.ticker.toUpperCase());
          }
        } catch {
          /* tape miss */
        }
      }),
    );
  }
  return hits;
}

function byMcap(a: DashRow, b: DashRow): number {
  const am = a.market_cap_cr ?? -1;
  const bm = b.market_cap_cr ?? -1;
  if (bm !== am) return bm - am;
  return a.ticker.localeCompare(b.ticker);
}

export function WatchlistDashboard({ tickers }: { tickers: string[] }) {
  const [rows, setRows] = useState<DashRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const syms = tickers.map((t) => t.trim().toUpperCase()).filter(Boolean);
    setError(null);
    if (!syms.length) {
      setRows([]);
      return;
    }
    setBusy(true);
    setStatus("Checking 200 DMA crosses…");
    try {
      const loaded = await loadIqRows(syms);
      const crossed = await loadCrossed200Dma(loaded);
      setRows(
        loaded
          .filter((r) => crossed.has(r.ticker.toUpperCase()))
          .sort(byMcap),
      );
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setBusy(false);
    }
  }, [tickers]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  return (
    <div className="wl-dash">
      <div className="wl-simple-toolbar">
        <button
          type="button"
          className={`chip chip-scan tag-chip${busy ? " busy on" : ""}`}
          disabled={busy || !tickers.length}
          onClick={() => void loadAll()}
          title="Refresh 200 DMA ↑ on Holdings and named lists"
        >
          {busy ? "Checking…" : "Scan 200 DMA"}
          <span className="chip-count">{rows.length}</span>
        </button>
      </div>
      {status ? (
        <p className="hint tight" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="hint tight" role="alert">
          {error}
        </p>
      ) : null}
      <p className="wl-dash-summary">
        {tickers.length} names on these lists · {rows.length} crossed above 200 DMA
      </p>
      <section className="wl-dash-section">
        <header className="wl-dash-section-head">
          <h2>200 DMA</h2>
          <span>{rows.length}</span>
        </header>
        {rows.length === 0 ? (
          <p className="miq-empty-hint">
            No 200 DMA ↑ hits on these lists yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table wl-simple-table wl-dash-table">
              <thead>
                <tr>
                  <th className="col-name">Company</th>
                  <th className="col-sec">Sec</th>
                  <th className="num col-mcap_cr">MCap</th>
                  <th className="num col-price">Price</th>
                  <th className="col-signal">200 DMA</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const tv = tradingviewUrl(r.ticker, r.market);
                  return (
                    <tr key={r.ticker}>
                      <td className="col-name">
                        <div className="company-watch-name">
                          <a
                            className="company-name wl-tv-name"
                            href={tv}
                            target="_blank"
                            rel="noreferrer"
                            title={`Open ${r.ticker} on TradingView`}
                          >
                            {r.company}
                          </a>
                          <span className="company-meta">
                            <span className="ticker">{r.ticker}</span>
                          </span>
                        </div>
                      </td>
                      <td className="col-sec">{r.sector || "—"}</td>
                      <td className="num col-mcap_cr">{fmtCr(r.market_cap_cr)}</td>
                      <td className="num col-price">{fmtPrice(r.price)}</td>
                      <td className="col-signal">
                        <span className="result-tag tag-dash-dma200">
                          200 DMA ↑
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
