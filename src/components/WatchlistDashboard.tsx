"use client";

import { useCallback, useMemo, useState } from "react";
import { napkinUrl, tradingviewUrl } from "@/lib/links";
import {
  loadCrossed200Dma,
  loadIqRows,
  type IqDashRow,
} from "@/lib/signal-hits";

export type DashSourceEntry = {
  ticker: string;
  sources: string[];
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

/** Last scan survives list switches, list reloads and page reloads. */
const SCAN_STORE_KEY = "wl-dash-scan-v1";
type SavedScan = { at: string; rows: DashRow[] };

function readSavedScan(key = SCAN_STORE_KEY): SavedScan | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const j = JSON.parse(raw) as SavedScan;
    return Array.isArray(j?.rows) ? j : null;
  } catch {
    return null;
  }
}

function writeSavedScan(scan: SavedScan, key = SCAN_STORE_KEY): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(scan));
  } catch {
    /* storage blocked — in-memory result still shows */
  }
}

function fmtScannedAt(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function hasAnySignal(r: DashRow): boolean {
  return r.crossed_200dma || !!r.has_bb_w || !!r.has_tq;
}

function bySignalThenMcap(a: DashRow, b: DashRow): number {
  const score = (r: DashRow) =>
    (r.crossed_200dma ? 8 : 0) +
    (r.has_bb_w ? 4 : 0) +
    (r.has_tq ? 2 : 0);
  const ds = score(b) - score(a);
  if (ds) return ds;
  const am = a.market_cap_cr ?? -1;
  const bm = b.market_cap_cr ?? -1;
  if (bm !== am) return bm - am;
  return a.ticker.localeCompare(b.ticker);
}

export function WatchlistDashboard({
  entries,
  storeKey = SCAN_STORE_KEY,
  sourceLabel = "From",
  onSource,
}: {
  /** Holdings + named-list universe with source labels. */
  entries: DashSourceEntry[];
  /** Saved-scan slot — separate dashboards must not share one. */
  storeKey?: string;
  /** Column / filter heading for `sources` (e.g. "Group"). */
  sourceLabel?: string;
  /** Click a source chip (e.g. open that group's map). */
  onSource?: (label: string) => void;
}) {
  // Last scan (restored from storage on mount) — rows derive from it below.
  const [scan, setScan] = useState<SavedScan | null>(() =>
    typeof window === "undefined" ? null : readSavedScan(storeKey),
  );
  const [sourcePick, setSourcePick] = useState<string | null>(null);
  const scannedAt = scan?.at ?? null;
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
      setScan(null);
      return;
    }

    setBusy(true);
    setStatus("Loading BB W / TQ W…");
    try {
      const loaded = await loadIqRows(syms);
      setStatus(`Checking 200 DMA crosses… 0/${loaded.length}`);
      const dmaHits = await loadCrossed200Dma(loaded, {
        onProgress: (done, total) =>
          setStatus(`Checking 200 DMA crosses… ${done}/${total}`),
      });
      const built: DashRow[] = loaded.map((r) => {
        const t = r.ticker.toUpperCase();
        const dma = dmaHits.get(t);
        return {
          ...r,
          ticker: t,
          price: dma?.price ?? r.price,
          sources: sourcesByTicker.get(t) ?? [],
          crossed_200dma: !!dma?.crossed,
        };
      });
      const next = built.filter(hasAnySignal).sort(bySignalThenMcap);
      const at = new Date().toISOString();
      setScan({ at, rows: next });
      writeSavedScan({ at, rows: next }, storeKey);
      setBusy(false);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setBusy(false);
    }
  }, [tickers, sourcesByTicker, storeKey]);

  // When lists change, keep hits for names still listed (refresh their
  // "From" labels) instead of wiping the results.
  const rows = useMemo(
    () =>
      (scan?.rows ?? [])
        .filter((r) => sourcesByTicker.has(r.ticker.toUpperCase()))
        .map((r) => ({
          ...r,
          sources: sourcesByTicker.get(r.ticker.toUpperCase()) ?? r.sources,
        }))
        // Older saved scans may hold 200W-only rows — no longer a signal.
        .filter(hasAnySignal),
    [scan, sourcesByTicker],
  );

  /** Sources with hits, most first — quick filter chips above the table. */
  const sourceTally = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) for (const s of r.sources) m.set(s, (m.get(s) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [rows]);
  const shown = useMemo(
    () => (sourcePick ? rows.filter((r) => r.sources.includes(sourcePick)) : rows),
    [rows, sourcePick],
  );

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
          title="Scan 200 DMA ↑, BB W, TQ W"
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
        {scannedAt ? ` · scanned ${fmtScannedAt(scannedAt)}` : ""}
      </p>
      {sourceTally.length > 1 ? (
        <div className="wl-dash-sources" role="group" aria-label={`Filter by ${sourceLabel}`}>
          <span className="wl-dash-sources-k">{sourceLabel}</span>
          <button
            type="button"
            className={`result-tag${sourcePick ? "" : " on"}`}
            onClick={() => setSourcePick(null)}
          >
            All {rows.length}
          </button>
          {sourceTally.map(([s, n]) => (
            <button
              key={s}
              type="button"
              className={`result-tag ${sourceChipClass(s)}${sourcePick === s ? " on" : ""}`}
              onClick={() => setSourcePick((v) => (v === s ? null : s))}
            >
              {s} {n}
            </button>
          ))}
        </div>
      ) : null}
      <section className="wl-dash-section">
        <header className="wl-dash-section-head">
          <h2>Signals</h2>
          <span>{shown.length}</span>
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
                  <th className="col-from">{sourceLabel}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
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
                            <a
                              className="np-chip"
                              href={napkinUrl(r.ticker)}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Open ${r.ticker} in Napkin`}
                            >
                              NP
                            </a>
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
                              title="Daily close ≥1% above 200 DMA after 5 closes below"
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
                            r.sources.map((s) =>
                              onSource ? (
                                <button
                                  key={`${r.ticker}|${s}`}
                                  type="button"
                                  className={`result-tag ${sourceChipClass(s)}`}
                                  title={`Open ${s}`}
                                  onClick={() => onSource(s)}
                                >
                                  {s}
                                </button>
                              ) : (
                                <span
                                  key={`${r.ticker}|${s}`}
                                  className={`result-tag ${sourceChipClass(s)}`}
                                >
                                  {s}
                                </span>
                              ),
                            )
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
