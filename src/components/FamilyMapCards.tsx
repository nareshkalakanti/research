"use client";

import { FamilyGraph } from "@/components/FamilyGraph";

export type FamilyRow = {
  family_name: string;
  company_count: number;
  companies: Array<{
    ticker: string;
    name: string;
    market: string;
    cap_code: string | null;
    market_cap_cr?: number | null;
    is_sme: boolean;
    family_directors?: number;
    directors?: number;
    din_verified?: number;
  }>;
  people?: Array<{
    person_id: string;
    name: string;
    din: string | null;
    tickers: string[];
  }>;
  outside?: Array<{ ticker: string; name: string; cap_code: string | null }>;
};

function dinTone(verified: number, total: number): "full" | "part" | "none" {
  if (!total || !verified) return "none";
  return verified >= total ? "full" : "part";
}

export function FamilyMapCards({
  rows,
  onTicker,
  onPerson,
  onChart,
}: {
  rows: FamilyRow[];
  /** Node click: open the company. */
  onTicker: (ticker: string, group: FamilyRow) => void;
  onPerson: (personId: string, name: string, group: FamilyRow) => void;
  /** Ticker-name click: open the chart. Falls back to `onTicker`. */
  onChart?: (ticker: string) => void;
}) {
  const allCompanies = rows.flatMap((f) => f.companies);
  return (
    <>
      {rows.length > 0 ? (
        <div className="gov-family-summary">
          <strong>{rows.length.toLocaleString()}</strong> groups ·{" "}
          <strong>
            {rows.reduce((n, f) => n + f.company_count, 0).toLocaleString()}
          </strong>{" "}
          listed companies ·{" "}
          <strong>
            {allCompanies
              .reduce((n, c) => n + (c.din_verified ?? 0), 0)
              .toLocaleString()}
            /
            {allCompanies
              .reduce((n, c) => n + (c.directors ?? 0), 0)
              .toLocaleString()}
          </strong>{" "}
          directors DIN-validated
        </div>
      ) : null}
      <div className="gov-family-grid">
        {rows.map((f) => {
          const key = `${f.family_name}:${f.companies.map((c) => c.ticker).join(",")}`;
          const dirTotal = f.companies.reduce((n, c) => n + (c.directors ?? 0), 0);
          const dinTotal = f.companies.reduce(
            (n, c) => n + (c.din_verified ?? 0),
            0,
          );
          const dinPct = dirTotal ? Math.round((dinTotal / dirTotal) * 100) : 0;
          const people = f.people ?? [];
          const outside = f.outside ?? [];
          return (
            <article key={key} className="gov-card gov-family-card">
              <header className="gov-family-head">
                <div className="gov-family-head-row">
                  <div className="gov-family-title-text">
                    <span className="gov-family-name">{f.family_name}</span>
                    <span className="gov-family-sub">
                      {f.company_count} companies · {people.length} linking people
                      {outside.length ? ` · ${outside.length} outside boards` : ""}
                    </span>
                  </div>
                  <div
                    className={`gov-family-din ${dinTone(dinTotal, dirTotal)}`}
                    title={`${dinTotal} of ${dirTotal} directors have a validated DIN`}
                  >
                    <span className="gov-family-din-label">DIN</span>
                    <span className="gov-family-din-val">
                      {dinTotal}/{dirTotal}
                    </span>
                    <span className="gov-family-din-pct">{dinPct}%</span>
                  </div>
                </div>
              </header>
              <FamilyGraph
                companies={f.companies}
                people={people}
                outside={outside}
                onCompany={(t) => onTicker(t, f)}
                onPerson={(id, name) => onPerson(id, name, f)}
                onTickerLabel={onChart}
              />
              <div className="gov-family-chips">
                {f.companies.map((c) => (
                  <button
                    key={c.ticker}
                    type="button"
                    className={`gov-family-chip ${dinTone(c.din_verified ?? 0, c.directors ?? 0)}`}
                    title={`${c.ticker} · ${c.din_verified ?? 0} of ${c.directors ?? 0} directors DIN-validated${onChart ? " · open on TradingView" : ""}`}
                    onClick={() => (onChart ? onChart(c.ticker) : onTicker(c.ticker, f))}
                  >
                    <span className="mono">{c.ticker}</span>
                    <span className="gov-family-chip-din">
                      {c.din_verified ?? 0}/{c.directors ?? 0}
                    </span>
                  </button>
                ))}
              </div>
            </article>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <div className="table-meta">No family groups with 2+ companies found.</div>
      ) : null}
    </>
  );
}
