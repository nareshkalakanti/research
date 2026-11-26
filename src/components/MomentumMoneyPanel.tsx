"use client";

import { useEffect, useMemo, useState } from "react";
import { napkinUrl, tradingviewUrl } from "@/lib/links";
import type { MmResult, MmRow } from "@/lib/momentum-money";

type Data = (MmResult & { ok: true }) | { ok: false; error: string };

const CAPS = [0, 100, 200, 300, 500, 1000, 2500, 5000, 10000, 25000];
const GAINS = [100, 150, 200, 300, 500];
type Exch = "all" | "nse" | "nsesme" | "bse" | "bsesme";
const EXCH: Array<[Exch, string]> = [
  ["all", "All"],
  ["nse", "NSE"],
  ["nsesme", "NSE SME"],
  ["bse", "BSE"],
  ["bsesme", "BSE SME"],
];
function exchOf(market: string): Exch {
  const m = market.toUpperCase();
  const sme = m.includes("SME") || m.includes("EMERGE");
  if (m.startsWith("BSE")) return sme ? "bsesme" : "bse";
  return sme ? "nsesme" : "nse";
}

const pct = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const cr = (v: number | null) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const listed = (iso: string | null) =>
  iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).replace(/\//g, "-") : "—";

/** Winners table as CSV (opens in Excel). */
function exportCsv(year: number, rows: MmRow[]) {
  const head = ["Symbol", "Date of Listing", "YoY Change %", "Gains from 52wk Low %", "Industry", "Market Cap (Cr)"];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = rows.map((r) =>
    [r.ticker, listed(r.listing_date), r.yoy_pct ?? "", r.gain_pct, r.industry ?? "", r.mcap_cr != null ? Math.round(r.mcap_cr) : ""]
      .map((v) => esc(String(v)))
      .join(","),
  );
  const blob = new Blob([[head.join(","), ...lines].join("\n") + "\n"], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `yearly-winners-${year}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function Sym({ r }: { r: MmRow }) {
  return (
    <span className="mm-sym">
      <a href={tradingviewUrl(r.ticker, r.market)} target="_blank" rel="noopener noreferrer">
        {r.ticker}
      </a>
      {r.market !== "NSE" ? <span className="mm-exch">{r.market}</span> : null}
      <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
        NP
      </a>
    </span>
  );
}

/** Money & Momentum: the year's winners (biggest gains from the 52-week low), nothing else. */
export function MomentumMoneyPanel() {
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1);
  const [data, setData] = useState<Data | null>(null);
  const [minCap, setMinCap] = useState(200);
  const [maxCap, setMaxCap] = useState(0);
  const [minGain, setMinGain] = useState(200);
  const [exch, setExch] = useState<Exch>("nse");

  useEffect(() => {
    let live = true;
    void fetch(`/api/momentum-money?year=${year}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Data) => {
        if (live) setData(j);
      })
      .catch((e) => {
        if (live) setData({ ok: false, error: String(e) });
      });
    return () => {
      live = false;
    };
  }, [year]);

  const rows = useMemo(
    () =>
      data?.ok
        ? data.rows.filter(
            (r) =>
              r.gain_pct >= minGain &&
              (minCap === 0 || (r.mcap_cr ?? 0) >= minCap) &&
              (maxCap === 0 || (r.mcap_cr != null && r.mcap_cr <= maxCap)) &&
              (exch === "all" || exchOf(r.market) === exch),
          )
        : [],
    [data, minGain, minCap, maxCap, exch],
  );
  const loading = !data || (data.ok && data.year !== year);

  return (
    <section className="vx mm">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">The year&rsquo;s biggest gainers from their 52-week low</span>
          <h2 className="vx-title">
            Money <span>&amp; Momentum</span>
          </h2>
        </div>
      </header>
      <div className="mm-winners">
        <div className="mm-filters">
          <label className="vx-field">
            <span className="vx-label">Year</span>
            <select
              value={year}
              onChange={(e) => {
                setData(null);
                setYear(Number(e.target.value));
              }}
            >
              {(data?.ok ? data.years : [year]).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="vx-field">
            <span className="vx-label">Min market cap (₹ Cr)</span>
            <select value={minCap} onChange={(e) => setMinCap(Number(e.target.value))}>
              {CAPS.filter((v) => maxCap === 0 || v < maxCap).map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? "Any" : v.toLocaleString("en-IN")}
                </option>
              ))}
            </select>
          </label>
          <label className="vx-field">
            <span className="vx-label">Max market cap (₹ Cr)</span>
            <select value={maxCap} onChange={(e) => setMaxCap(Number(e.target.value))}>
              {CAPS.filter((v) => v === 0 || v > minCap).map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? "Any" : v.toLocaleString("en-IN")}
                </option>
              ))}
            </select>
          </label>
          <label className="vx-field">
            <span className="vx-label">Min gain %</span>
            <select value={minGain} onChange={(e) => setMinGain(Number(e.target.value))}>
              {GAINS.map((v) => (
                <option key={v} value={v}>
                  {v}%
                </option>
              ))}
            </select>
          </label>
          <label className="vx-field">
            <span className="vx-label">Exchange</span>
            <select value={exch} onChange={(e) => setExch(e.target.value as Exch)}>
              {EXCH.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="mm-export" disabled={!rows.length} onClick={() => exportCsv(year, rows)}>
            Export to Excel
          </button>
        </div>

        {loading ? (
          <div className="vx-card vx-empty">Finding the {year} winners…</div>
        ) : !data.ok ? (
          <div className="vx-card vx-empty vx-msg--err">Could not load: {data.error}</div>
        ) : (
          <>
            <h3 className="mm-h">
              Winners {year} <span>{rows.length} stocks with {minGain}%+ gains from the 52-week low</span>
            </h3>
            <div className="mm-wrap">
              <table className="vx-table mm-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Date of Listing</th>
                    <th className="num">YoY Change</th>
                    <th className="num">Gains from 52wk Low</th>
                    <th>Industry</th>
                    <th className="num">Market Cap (₹ Cr)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.ticker}>
                      <td>
                        <Sym r={r} />
                      </td>
                      <td>{listed(r.listing_date)}</td>
                      <td className={`num ${r.yoy_pct != null && r.yoy_pct < 0 ? "neg" : ""}`}>{pct(r.yoy_pct)}</td>
                      <td className="num pos">{pct(r.gain_pct)}</td>
                      <td>
                        {r.industry ?? "—"}
                        {r.sector && r.sector !== r.industry ? <small className="ind-sector">{r.sector}</small> : null}
                      </td>
                      <td className="num">{cr(r.mcap_cr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
