"use client";

import { useEffect, useMemo, useState } from "react";
import { napkinUrl } from "@/lib/links";
import type { DashInvestor, DashSector, DashStock, FundDashboard, Move } from "@/lib/fund-dashboard";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-Q3" → "Sep 26": the quarter-end month, as shareholding filings are labelled. */
const qEnd = (k: string | null) => (k ? `${MON[Number(k.slice(6)) * 3 - 1]} ${k.slice(2, 4)}` : "—");
/** "2026-Q4" → "Oct–Dec 26": the picks tracker's quarter label. */
const qSpan = (k: string) => {
  const q = Number(k.slice(6));
  return `${MON[(q - 1) * 3]}–${MON[(q - 1) * 3 + 2]} ${k.slice(2, 4)}`;
};

const MOVE: Record<Move, { label: string; cls: string }> = {
  entered: { label: "Bought", cls: "in" },
  added: { label: "Added", cls: "up" },
  cut: { label: "Cut", cls: "down" },
  exited: { label: "Sold", cls: "out" },
  held: { label: "Held", cls: "" },
};

const stockChip = (s: DashStock) => (
  <a
    key={s.ticker}
    className={`fd-chip ${MOVE[s.move].cls}`}
    href={napkinUrl(s.ticker)}
    target="_blank"
    rel="noopener noreferrer"
    title={`${s.name ?? s.ticker} · ${MOVE[s.move].label}${s.before != null ? ` · ${s.before}%` : ""}${s.now != null ? ` → ${s.now}%` : " → under 1%"}`}
  >
    {s.ticker}
  </a>
);

/** Followed investors compared by industry: what they hold, where they are buying and selling, where both are building. */
export function FundDashboardPanel() {
  const [a, setA] = useState("niveshaay");
  const [b, setB] = useState("kacholia");
  const [data, setData] = useState<FundDashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/fund-dashboard?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: FundDashboard & { ok: boolean; error?: string }) => {
        if (!live) return;
        if (!j.ok) setErr(j.error ?? "Could not load");
        else {
          setData(j);
          setErr(null);
        }
      })
      .catch((e) => live && setErr(String(e)));
    return () => {
      live = false;
    };
  }, [a, b]);

  const [A, B] = [data?.investors.find((i) => i.key === a), data?.investors.find((i) => i.key === b)];

  const both = useMemo(() => {
    if (!A || !B) return [];
    const bs = new Map(B.sectors.map((s) => [s.sector, s]));
    return A.sectors
      .filter((s) => s.score > 0 && (bs.get(s.sector)?.score ?? 0) > 0)
      .map((s) => ({ sector: s.sector, a: s, b: bs.get(s.sector)! }))
      .sort((x, y) => y.a.score + y.b.score - (x.a.score + x.b.score));
  }, [A, B]);

  const table = useMemo(() => {
    if (!A || !B) return [];
    const names = new Set([...A.sectors.map((s) => s.sector), ...B.sectors.map((s) => s.sector)]);
    const am = new Map(A.sectors.map((s) => [s.sector, s]));
    const bm = new Map(B.sectors.map((s) => [s.sector, s]));
    return [...names]
      .map((n) => ({ sector: n, a: am.get(n) ?? null, b: bm.get(n) ?? null }))
      .sort(
        (x, y) =>
          (y.a?.score ?? 0) + (y.b?.score ?? 0) - ((x.a?.score ?? 0) + (x.b?.score ?? 0)) ||
          (y.a?.held ?? 0) + (y.b?.held ?? 0) - ((x.a?.held ?? 0) + (x.b?.held ?? 0)) ||
          x.sector.localeCompare(y.sector),
      );
  }, [A, B]);

  const options = data?.options ?? [];
  const picker = (value: string, set: (v: string) => void, other: string, label: string) => (
    <label className="vx-field">
      <span className="vx-label">{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)}>
        {options
          .filter((o) => o.key !== other)
          .map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
      </select>
    </label>
  );

  return (
    <section className="vx fd-root">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">What two investors are buying and selling, industry by industry</span>
          <h2 className="vx-title">
            Fund <span>dashboard</span>
          </h2>
        </div>
        <div className="fd-pickers">
          {picker(a, setA, b, "Investor 1")}
          {picker(b, setB, a, "Investor 2")}
        </div>
      </header>

      {err ? <p className="vx-msg vx-msg--err">{err}</p> : null}
      {!A || !B ? (
        <div className="vx-card vx-empty">Loading…</div>
      ) : (
        <>
          <p className="vx-hint fd-note">
            From Screener shareholding filings, which list stakes of 1% or more. Moves compare the latest filing ({qEnd(A.latest)}) with {qEnd(A.since)}.
            &ldquo;Bought&rdquo; means the stake crossed 1%, &ldquo;Sold&rdquo; that it fell under 1%.
          </p>

          <div className="fd-grid">
            {[A, B].map((inv) => (
              <InvestorCard key={inv.key} inv={inv} />
            ))}
          </div>

          <div className="vx-card fd-card">
            <h3 className="fd-h">Both building</h3>
            <p className="vx-hint">Industries where both are buying or adding since {qEnd(A.since)}.</p>
            {both.length ? (
              <ul className="fd-both">
                {both.map((x) => (
                  <li key={x.sector}>
                    <b>{x.sector}</b>
                    <span className="fd-both-side">
                      <em>{A.label}</em>
                      {x.a.stocks.filter((s) => s.move === "entered" || s.move === "added").map(stockChip)}
                    </span>
                    <span className="fd-both-side">
                      <em>{B.label}</em>
                      {x.b.stocks.filter((s) => s.move === "entered" || s.move === "added").map(stockChip)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="vx-hint">No industry where both are building right now.</p>
            )}
          </div>

          {[A, B]
            .filter((inv) => inv.picks)
            .map((inv) => (
              <PicksAhead key={inv.key} inv={inv} />
            ))}

          <div className="vx-card fd-card">
            <h3 className="fd-h">Industry by industry</h3>
            <div className="fd-table-wrap">
              <table className="fd-table">
                <thead>
                  <tr>
                    <th>Industry</th>
                    <th>{A.label}</th>
                    <th>{B.label}</th>
                  </tr>
                </thead>
                <tbody>
                  {table.map((r) => (
                    <tr key={r.sector}>
                      <td className="fd-sector">{r.sector}</td>
                      <td>
                        <SectorCell s={r.a} />
                      </td>
                      <td>
                        <SectorCell s={r.b} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="vx-hint fd-legend">
              <span className="fd-chip in">Bought</span> <span className="fd-chip up">Added</span> <span className="fd-chip">Held</span>{" "}
              <span className="fd-chip down">Cut</span> <span className="fd-chip out">Sold</span> · hover a stock for its stake
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function InvestorCard({ inv }: { inv: DashInvestor }) {
  const count = (m: keyof Pick<DashSector, "entered" | "added" | "cut" | "exited">) => inv.sectors.reduce((n, s) => n + s[m], 0);
  const into = inv.sectors.filter((s) => s.score > 0).slice(0, 6);
  const out = inv.sectors.filter((s) => s.score < 0).sort((x, y) => x.score - y.score).slice(0, 4);
  return (
    <div className="vx-card fd-card">
      <div className="fd-inv-head">
        <h3 className="fd-h">{inv.label}</h3>
        <span className="vx-hint">
          {inv.holdings} holdings · filing {qEnd(inv.latest)}
        </span>
      </div>
      <div className="fd-stats">
        <span className="in">{count("entered")} bought</span>
        <span className="up">{count("added")} added</span>
        <span className="down">{count("cut")} cut</span>
        <span className="out">{count("exited")} sold</span>
      </div>
      <h4 className="fd-sub">Heading into</h4>
      {into.length ? (
        <ul className="fd-list">
          {into.map((s) => (
            <li key={s.sector}>
              <span className="fd-list-name">{s.sector}</span>
              <span className="fd-list-chips">{s.stocks.filter((x) => x.move === "entered" || x.move === "added").map(stockChip)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="vx-hint">No new buying since {qEnd(inv.since)}.</p>
      )}
      {out.length ? (
        <>
          <h4 className="fd-sub">Getting out of</h4>
          <ul className="fd-list">
            {out.map((s) => (
              <li key={s.sector}>
                <span className="fd-list-name">{s.sector}</span>
                <span className="fd-list-chips">{s.stocks.filter((x) => x.move === "cut" || x.move === "exited").map(stockChip)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** The investor's own latest picks by industry: where the fund may go next, flagged when it holds nothing there yet. */
function PicksAhead({ inv }: { inv: DashInvestor }) {
  const held = new Set(inv.sectors.filter((s) => s.held > 0).map((s) => s.sector));
  const p = inv.picks!;
  return (
    <div className="vx-card fd-card">
      <h3 className="fd-h">
        {inv.label}&rsquo;s picks · {qSpan(p.quarter)}
      </h3>
      <p className="vx-hint">
        Industries of their latest recommendations (Picks tracker). <b>Not held yet</b> = the fund has no 1%+ stake in that industry — a place it may enter next.
      </p>
      <ul className="fd-list">
        {p.sectors.map((s) => (
          <li key={s.sector}>
            <span className="fd-list-name">
              {s.sector} <b className="fd-n">{s.n}</b>
              {held.has(s.sector) ? <span className="fd-tag">Fund holds</span> : <span className="fd-tag fd-tag--new">Not held yet</span>}
            </span>
            <span className="fd-list-chips">
              {s.tickers.map((t) => (
                <a key={t} className="fd-chip" href={napkinUrl(t)} target="_blank" rel="noopener noreferrer">
                  {t}
                </a>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SectorCell({ s }: { s: DashSector | null }) {
  if (!s) return <span className="fd-blank">—</span>;
  return (
    <span className="fd-cell">
      <span className="fd-cell-n">{s.held} held</span>
      {s.stocks.map(stockChip)}
    </span>
  );
}
