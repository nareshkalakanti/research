"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { tradingviewUrl } from "@/lib/links";

export type DashSourceEntry = {
  ticker: string;
  sources: string[];
};

type IqDashRow = {
  ticker: string;
  company: string;
  market: string | null;
  price: number | null;
  market_cap_cr: number | null;
  sector: string | null;
  has_bb_w?: boolean;
  has_tq?: boolean;
  tq_score?: number | null;
};

type DashRow = IqDashRow & {
  sources: string[];
  crossed_200dma: boolean;
};

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })} Cr`;
}

function sourceChipClass(label: string): string {
  const key = label.trim().toLowerCase();
  if (key === "holdings") return "tag-hold";
  if (key === "watchlist" || key === "watch") return "tag-watch";
  return "tag-named";
}

async function loadIqRows(syms: string[]): Promise<IqDashRow[]> {
  const CHUNK = 40;
  const collected: IqDashRow[] = [];
  for (let i = 0; i < syms.length; i += CHUNK) {
    const chunk = syms.slice(i, i + CHUNK);
    const res = await fetch(
      `/api/iq-master?tickers=${encodeURIComponent(chunk.join(","))}`,
    );
    const json = (await res.json()) as { ok?: boolean; rows?: IqDashRow[] };
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
        has_bb_w: false,
        has_tq: false,
        tq_score: null,
      }
    );
  });
}

async function loadCrossed200Dma(
  rows: IqDashRow[],
): Promise<Map<string, { crossed: boolean; price: number | null }>> {
  const hits = new Map<string, { crossed: boolean; price: number | null }>();
  const CHUNK = 8;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (row) => {
        const key = row.ticker.toUpperCase();
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
              crossed_above_200dma?: boolean;
            };
          };
          if (!json.ok || !json.tape) {
            hits.set(key, { crossed: false, price: null });
            return;
          }
          hits.set(key, {
            crossed: !!json.tape.crossed_above_200dma,
            price: json.tape.price ?? null,
          });
        } catch {
          hits.set(key, { crossed: false, price: null });
        }
      }),
    );
  }
  return hits;
}

function hasAnySignal(r: DashRow): boolean {
  return r.crossed_200dma || !!r.has_bb_w || !!r.has_tq;
}

function bySignalThenMcap(a: DashRow, b: DashRow): number {
  const score = (r: DashRow) =>
    (r.crossed_200dma ? 4 : 0) + (r.has_bb_w ? 2 : 0) + (r.has_tq ? 1 : 0);
  const ds = score(b) - score(a);
  if (ds) return ds;
  const am = a.market_cap_cr ?? -1;
  const bm = b.market_cap_cr ?? -1;
  if (bm !== am) return bm - am;
  return a.ticker.localeCompare(b.ticker);
}

export function WatchlistDashboard({
  entries,
}: {
  /** Holdings + named-list universe with source labels. */
  entries: DashSourceEntry[];
}) {
  const [rows, setRows] = useState<DashRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tickers = useMemo(
    () => entries.map((e) => e.ticker.trim().toUpperCase()).filter(Boolean),
    [entries],
  );
  const sourcesByTicker = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of entries) {
      m.set(e.ticker.trim().toUpperCase(), e.sources);
    }
    return m;
  }, [entries]);

  const loadAll = useCallback(async () => {
    const syms = tickers;
    setError(null);
    if (!syms.length) {
      setRows([]);
      return;
    }
    setBusy(true);
    setStatus("Loading BB W / TQ W…");
    try {
      const loaded = await loadIqRows(syms);
      setStatus("Checking 200 DMA crosses…");
      const dmaHits = await loadCrossed200Dma(loaded);
      const next: DashRow[] = loaded
        .map((r) => {
          const t = r.ticker.toUpperCase();
          const dma = dmaHits.get(t);
          return {
            ...r,
            ticker: t,
            price: dma?.price ?? r.price,
            sources: sourcesByTicker.get(t) ?? [],
            crossed_200dma: !!dma?.crossed,
          };
        })
        .filter(hasAnySignal)
        .sort(bySignalThenMcap);
      setRows(next);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setBusy(false);
    }
  }, [tickers, sourcesByTicker]);

  const entriesKey = useMemo(
    () =>
      entries
        .map((e) => `${e.ticker}:${e.sources.join(",")}`)
        .join("|"),
    [entries],
  );

  useEffect(() => {
    setRows([]);
    setStatus(null);
    setError(null);
  }, [entriesKey]);

  const counts = useMemo(() => {
    let dma = 0;
    let bbw = 0;
    let tq = 0;
    for (const r of rows) {
      if (r.crossed_200dma) dma += 1;
      if (r.has_bb_w) bbw += 1;
      if (r.has_tq) tq += 1;
    }
    return { dma, bbw, tq };
  }, [rows]);

  return (
    <div className="wl-dash">
      <div className="wl-simple-toolbar">
        <button
          type="button"
          className={`chip chip-scan tag-chip${busy ? " busy on" : ""}`}
          disabled={busy || !tickers.length}
          onClick={() => void loadAll()}
          title="Scan 200 DMA ↑ plus BB W / TQ W from local signals"
        >
          {busy ? "Checking…" : "Scan signals"}
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
        {tickers.length} names · {counts.dma} × 200 DMA · {counts.bbw} × BB W ·{" "}
        {counts.tq} × TQ W
      </p>
      <section className="wl-dash-section">
        <header className="wl-dash-section-head">
          <h2>Signals</h2>
          <span>{rows.length}</span>
        </header>
        {rows.length === 0 ? (
          <p className="miq-empty-hint">
            No 200 DMA ↑, BB W, or TQ W hits on these lists yet. Run Scan
            signals.
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
                  <th className="col-signal">Signals</th>
                  <th className="col-from">From</th>
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
                      <td className="num col-mcap_cr">
                        {fmtCr(r.market_cap_cr)}
                      </td>
                      <td className="num col-price">{fmtPrice(r.price)}</td>
                      <td className="col-signal">
                        <span className="result-tags wl-dash-signal-tags">
                          {r.crossed_200dma ? (
                            <span
                              className="result-tag tag-dash-dma200"
                              title="Last close moved above 200 DMA (prior close was below)"
                            >
                              200 DMA ↑
                            </span>
                          ) : null}
                          {r.has_bb_w ? (
                            <span
                              className="result-tag tag-dash-bbw"
                              title="BB NEW weekly"
                            >
                              BB W
                            </span>
                          ) : null}
                          {r.has_tq ? (
                            <span
                              className="result-tag tag-dash-tq"
                              title="TQ weekly crossover"
                            >
                              {r.tq_score != null
                                ? `TQ W ${Math.round(r.tq_score)}`
                                : "TQ W"}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="col-from">
                        <span className="result-tags wl-dash-from-tags">
                          {r.sources.length ? (
                            r.sources.map((s) => (
                              <span
                                key={`${r.ticker}|${s}`}
                                className={`result-tag ${sourceChipClass(s)}`}
                              >
                                {s}
                              </span>
                            ))
                          ) : (
                            <span className="result-tag">—</span>
                          )}
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
