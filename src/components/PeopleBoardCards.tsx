"use client";

import { LazyFamilyGraph } from "@/components/FamilyGraph";

export type PersonBoardRow = {
  person_id: string;
  din: string | null;
  name: string;
  board_count: number;
  dir_score: number;
  din_backed: boolean;
  companies: Array<{
    ticker: string;
    name: string;
    market: string;
    cap_code: string | null;
    market_cap_cr?: number | null;
    is_sme: boolean;
    designation?: string;
  }>;
};

function uniqueByTicker<T extends { ticker: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const t = row.ticker.trim().toUpperCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(row);
  }
  return out;
}

export function PeopleBoardCards({
  rows,
  onTicker,
  onPerson,
  chartUrl,
}: {
  rows: PersonBoardRow[];
  onTicker: (ticker: string) => void;
  onPerson: (personId: string, name: string) => void;
  chartUrl?: (ticker: string) => string;
}) {
  const boardTotal = rows.reduce((n, r) => n + r.board_count, 0);
  return (
    <>
      {rows.length > 0 ? (
        <div className="gov-family-summary">
          <strong>{rows.length.toLocaleString()}</strong> people ·{" "}
          <strong>{boardTotal.toLocaleString()}</strong> board seats
        </div>
      ) : null}
      <div className="gov-family-grid">
        {rows.map((r) => {
          const companies = uniqueByTicker(r.companies);
          const people = [
            {
              person_id: r.person_id,
              name: r.name,
              din: r.din,
              tickers: companies.map((c) => c.ticker),
            },
          ];
          return (
            <article key={r.person_id} className="gov-card gov-family-card">
              <header className="gov-family-head">
                <div className="gov-family-head-row">
                  <div className="gov-family-title-text">
                    <button
                      type="button"
                      className="gov-family-name gov-person-name-btn"
                      onClick={() => onPerson(r.person_id, r.name)}
                      title="Open this person in Governance"
                    >
                      {r.name}
                      {r.din_backed ? (
                        <span className="gov-badge">DIN</span>
                      ) : (
                        <span className="gov-badge name">name</span>
                      )}
                    </button>
                    <span className="gov-family-sub">
                      {r.din ? `DIN ${r.din} · ` : ""}
                      {r.board_count} boards
                      {r.dir_score != null
                        ? ` · score ${Math.round(r.dir_score)}`
                        : ""}
                    </span>
                  </div>
                </div>
              </header>
              <LazyFamilyGraph
                companies={companies}
                people={people}
                outside={[]}
                onCompany={onTicker}
                onPerson={(id, name) => onPerson(id, name)}
                chartUrl={chartUrl}
              />
              <div className="gov-family-chips">
                {companies.map((c) => {
                  const title = `${c.ticker} · ${c.name}${c.designation ? ` · ${c.designation}` : ""} — show related boards`;
                  return (
                    <button
                      key={c.ticker}
                      type="button"
                      className="gov-family-chip part"
                      title={title}
                      onClick={() => onTicker(c.ticker)}
                    >
                      <span className="mono">{c.ticker}</span>
                    </button>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <div className="table-meta">No multi-board people found.</div>
      ) : null}
    </>
  );
}
