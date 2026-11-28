"use client";

import { useEffect, useState } from "react";

/**
 * Shared StockScans sector board (same idea as Micro Monopolies):
 * black header = sector avg return · High / Low = best/worst industries inside.
 */

export type BoardIndustry = {
  industry: string;
  n: number;
  avg_ret: number;
};

export type BoardSector = {
  sector: string;
  n: number;
  avg_ret: number;
  high: BoardIndustry | null;
  low: BoardIndustry | null;
  industries: BoardIndustry[];
};

export type BoardSel = { sector: string; industry: string | null };

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(0)}%`;
}

function Ret({ n, light }: { n: number; light?: boolean }) {
  const cls = light ? "mcs-ret mcs-ret--light" : n > 0 ? "mcs-ret up" : n < 0 ? "mcs-ret down" : "mcs-ret";
  return <span className={cls}>{pct(n)}</span>;
}

function same(a: BoardSel | null, b: BoardSel | null): boolean {
  if (!a || !b) return a === b;
  return a.sector === b.sector && a.industry === b.industry;
}

function Column({
  s,
  sel,
  onPick,
  /** both = High+Low+list · high = sector + High only (Top view). */
  band = "both",
}: {
  s: BoardSector;
  sel: BoardSel | null;
  onPick: (next: BoardSel) => void;
  band?: "both" | "high";
}) {
  const hasPair =
    !!(s.low && s.high) &&
    (s.low.industry !== s.high.industry || s.low.avg_ret !== s.high.avg_ret);
  const showHigh = !!s.high && (band === "high" || hasPair);
  const showLow = band === "both" && !!s.low && hasPair;
  const showList = band === "both" && s.industries.length > 0;
  const sectorOn = same(sel, { sector: s.sector, industry: null });

  return (
    <article className={`mcs-col${sectorOn ? " mcs-col--on" : ""}`}>
      <header className="mcs-col-head">
        <button
          type="button"
          className="mcs-col-title mcs-pick"
          title="All names in this sector"
          onClick={() => onPick({ sector: s.sector, industry: null })}
        >
          <h3>{s.sector}</h3>
          <span>{s.n.toLocaleString("en-IN")} cos</span>
        </button>
        <b>
          <Ret n={s.avg_ret} light />
        </b>
      </header>

      {showHigh || showLow ? (
        <div className="mcs-col-band">
          {showHigh ? (
            <button
              type="button"
              className={`mcs-band-btn high${same(sel, { sector: s.sector, industry: s.high!.industry }) ? " on" : ""}`}
              title={`${s.high!.n} stocks`}
              onClick={() => onPick({ sector: s.sector, industry: s.high!.industry })}
            >
              <em>High</em>
              <span className="mcs-ind">{s.high!.industry}</span>
              <Ret n={s.high!.avg_ret} />
            </button>
          ) : null}
          {showLow ? (
            <button
              type="button"
              className={`mcs-band-btn low${same(sel, { sector: s.sector, industry: s.low!.industry }) ? " on" : ""}`}
              title={`${s.low!.n} stocks`}
              onClick={() => onPick({ sector: s.sector, industry: s.low!.industry })}
            >
              <em>Low</em>
              <span className="mcs-ind">{s.low!.industry}</span>
              <Ret n={s.low!.avg_ret} />
            </button>
          ) : null}
        </div>
      ) : null}

      {showList ? (
        <ul className="mcs-col-list">
          {s.industries.map((i) => {
            const on = same(sel, { sector: s.sector, industry: i.industry });
            return (
              <li key={i.industry}>
                <button
                  type="button"
                  className={`mcs-ind-btn${on ? " on" : ""}`}
                  title={`${i.n} stocks`}
                  onClick={() => onPick({ sector: s.sector, industry: i.industry })}
                >
                  <span className="mcs-ind">
                    {i.industry}
                    <small className="mcs-n">{i.n}</small>
                  </span>
                  <Ret n={i.avg_ret} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}

/** Build High / Low from industry rows (need ≥2 named for a pair). */
export function withHighLow(industries: BoardIndustry[]): {
  high: BoardIndustry | null;
  low: BoardIndustry | null;
} {
  const named = industries.filter((x) => x.industry && x.industry !== "Other");
  if (named.length < 2) return { high: null, low: null };
  const byRet = [...named].sort(
    (a, b) => b.avg_ret - a.avg_ret || a.industry.localeCompare(b.industry),
  );
  return { high: byRet[0]!, low: byRet[byRet.length - 1]! };
}

/** Best industry even when High/Low pair is missing (single named industry). */
export function pickHighIndustry(s: BoardSector): BoardIndustry | null {
  if (s.high) return s.high;
  const named = s.industries.filter((x) => x.industry && x.industry !== "Other");
  const pool = named.length ? named : s.industries;
  if (!pool.length) return null;
  return [...pool].sort((a, b) => b.avg_ret - a.avg_ret || a.industry.localeCompare(b.industry))[0] ?? null;
}

export function StockscansSectorBoard({
  sectors,
  sel,
  onPick,
  limit = 7,
  empty = "No sectors match.",
  /** high = Top view: sector header + High only, show every sector passed in. */
  band = "both",
}: {
  sectors: BoardSector[];
  sel: BoardSel | null;
  onPick: (next: BoardSel) => void;
  limit?: number;
  empty?: string;
  band?: "both" | "high";
}) {
  const start = band === "high" ? sectors.length : limit;
  const [showAll, setShowAll] = useState(start);
  useEffect(() => {
    setShowAll(band === "high" ? sectors.length : limit);
  }, [limit, sectors.length, band]);
  const shown = sectors.slice(0, showAll);

  if (!sectors.length) return <div className="vx-card vx-empty">{empty}</div>;

  return (
    <>
      <div className="mcs-board" role="list" aria-label="StockScans sector columns">
        {shown.map((s) => (
          <div key={s.sector} role="listitem">
            <Column s={s} sel={sel} onPick={onPick} band={band} />
          </div>
        ))}
      </div>
      {band === "both" && sectors.length > showAll ? (
        <button type="button" className="vx-btn mcs-more" onClick={() => setShowAll(sectors.length)}>
          Show all {sectors.length} sectors
        </button>
      ) : band === "both" && showAll > limit && sectors.length > limit ? (
        <button type="button" className="link-btn mcs-more" onClick={() => setShowAll(limit)}>
          Show top {limit}
        </button>
      ) : null}
    </>
  );
}
