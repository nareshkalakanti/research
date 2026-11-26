"use client";

import { useEffect, useState } from "react";
import type { FundHolder } from "@/lib/screener-people";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-Q3" → "Sep 26" (the quarter-end month, as Screener labels the filing). */
const qShort = (k: string) => `${MON[Number(k.slice(6)) * 3 - 1]} ${k.slice(2, 4)}`;

const CHANGE: Record<FundHolder["change"], { label: string; cls: string }> = {
  new: { label: "New", cls: "new" },
  increased: { label: "Increased", cls: "up" },
  decreased: { label: "Decreased", cls: "down" },
  unchanged: { label: "Unchanged", cls: "" },
  exited: { label: "Exited / under 1%", cls: "down" },
};

/**
 * Napkin: followed funds (Screener people pages, e.g. Niveshaay) holding this stock — 1%+ shareholding
 * filings per quarter, with the latest change. Renders nothing when no followed fund holds it.
 */
export function NapkinFundHolders({ ticker }: { ticker: string }) {
  const [data, setData] = useState<{ t: string; quarters: string[]; holders: FundHolder[] } | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/fund-holders?ticker=${encodeURIComponent(ticker)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { ok: boolean; quarters?: string[]; holders?: FundHolder[] }) => {
        if (live && j.ok) setData({ t: ticker, quarters: j.quarters ?? [], holders: j.holders ?? [] });
      })
      .catch(() => {
        /* optional section */
      });
    return () => {
      live = false;
    };
  }, [ticker]);

  if (!data || data.t !== ticker || !data.holders.length) return null;
  const cols = data.quarters.slice(-6);

  return (
    <div className="napkin-sheet-section napkin-holders">
      <div className="napkin-holders-head">
        <h2 className="napkin-block-title">Who&rsquo;s holding it</h2>
        <span className="napkin-holders-note">Followed funds · shareholding filings list stakes of 1% or more</span>
      </div>
      <div className="napkin-holders-wrap">
        <table className="napkin-holders-table">
          <thead>
            <tr>
              <th>Fund</th>
              {cols.map((q) => (
                <th key={q} className="num">
                  {qShort(q)}
                </th>
              ))}
              <th>Latest change</th>
            </tr>
          </thead>
          <tbody>
            {data.holders.map((h) => {
              const c = CHANGE[h.change];
              const delta = h.latest != null && h.prev != null ? h.latest - h.prev : null;
              return (
                <tr key={h.url}>
                  <td>
                    <a href={h.url} target="_blank" rel="noopener noreferrer" title="Open on Screener">
                      {h.fund}
                    </a>
                    {h.investor && !h.fund.toLowerCase().includes(h.investor.toLowerCase()) ? <small>{h.investor}</small> : null}
                  </td>
                  {cols.map((q, i) => {
                    const v = h.series[q];
                    const pv = i > 0 ? h.series[cols[i - 1]!] : undefined;
                    const cls = v == null || pv == null ? "" : v > pv + 0.05 ? "up" : v < pv - 0.05 ? "down" : "";
                    return (
                      <td key={q} className={`num ${cls}`}>
                        {v != null ? `${v.toFixed(2)}%` : <span className="napkin-holders-blank">·</span>}
                      </td>
                    );
                  })}
                  <td className={`napkin-holders-change ${c.cls}`}>
                    {c.label}
                    {delta != null && h.change !== "unchanged" && Math.abs(delta) > 0.005 ? ` ${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)} pts` : ""}
                    {/* Pages pulled before quarter history was kept: show the latest stake here instead. */}
                    {!Object.keys(h.series).length && h.latest != null ? ` · ${h.latest}% now` : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
