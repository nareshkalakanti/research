"use client";

import { useCallback, useEffect, useState } from "react";

type DistressRow = {
  ticker: string;
  name: string | null;
  market: string;
  yahoo_symbol: string;
  distress: {
    distress_score: number;
    distress_flags: string[];
    flag_labels: string[];
    distress_reason: string;
    drawdown_pct: number | null;
    bounce_pct: number | null;
    eps_yoy: number | null;
    sales_yoy: number | null;
    pe: number | null;
    mcap_cr: number | null;
    price: number | null;
    returns_pct: number | null;
  } | null;
};

type Gate = { id: string; title: string; detail: string };

type TurnaroundResponse = {
  ok: boolean;
  error?: string;
  holdings_count?: number;
  rows?: DistressRow[];
  discovery_gates?: Gate[];
};

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n}%`;
}

function scoreClass(score: number): string {
  if (score >= 60) return "hot";
  if (score >= 40) return "warm";
  return "";
}

export function TurnaroundDistressPanel() {
  const [data, setData] = useState<TurnaroundResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [gatesOpen, setGatesOpen] = useState(false);

  const load = useCallback(async (refresh?: boolean) => {
    setLoading(true);
    try {
      const q = refresh ? "?refresh=1" : "";
      const res = await fetch(`/api/turnaround-holdings${q}`);
      setData((await res.json()) as TurnaroundResponse);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.rows ?? [];
  const gates = data?.discovery_gates ?? [];

  return (
    <section className="sm-section sm-turnaround">
      <div className="sm-section-head">
        <h3>Distress turnaround (8 seeds)</h3>
        <span className="sm-section-sub">
          {loading
            ? "Scoring…"
            : `${rows.length} holdings · rule-based distress tags`}
        </span>
      </div>
      <p className="sm-turnaround-lead">
        Each name is scored 0–100 from Yahoo fundamentals: drawdown, bounce off
        lows, sales vs EPS, P/E, mcap. Seeds always pass the gate; tags show
        which recovery signals fired.
      </p>

      {rows.length ? (
        <div className="table-card sm-table-wrap">
          <table className="data-table sm-distress-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th className="num">Score</th>
                <th className="num">DD</th>
                <th className="num">Bounce</th>
                <th className="num">Sales</th>
                <th className="num">EPS</th>
                <th className="num">P/E</th>
                <th className="num">Mcap</th>
                <th>Distress tags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = r.distress;
                return (
                  <tr key={r.ticker}>
                    <td className="mono">
                      <div className="sm-ticker-cell">{r.ticker}</div>
                      <div className="sm-ticker-name">{r.name ?? "—"}</div>
                    </td>
                    <td className="num">
                      {d ? (
                        <span
                          className={`sm-distress-score ${scoreClass(d.distress_score)}`}
                        >
                          {d.distress_score}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num">{fmtPct(d?.drawdown_pct)}</td>
                    <td className="num">{fmtPct(d?.bounce_pct)}</td>
                    <td className="num">{fmtPct(d?.sales_yoy)}</td>
                    <td className="num">{fmtPct(d?.eps_yoy)}</td>
                    <td className="num">{d?.pe ?? "—"}</td>
                    <td className="num">{d?.mcap_cr ?? "—"}</td>
                    <td className="sm-tags">
                      {d?.flag_labels?.length
                        ? d.flag_labels.map((label, i) => (
                            <span
                              key={`${r.ticker}-${d.distress_flags[i] ?? i}`}
                              className={`sm-tag sm-tag-distress ${d.distress_flags[i] === "seed" ? "seed" : ""}`}
                              title={d.distress_reason}
                            >
                              {label}
                            </span>
                          ))
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : loading ? (
        <p className="muted sm-muted">Loading distress scores…</p>
      ) : null}

      <div className="sm-turnaround-actions">
        <button
          type="button"
          className="btn-refresh"
          disabled={loading}
          onClick={() => void load(true)}
        >
          Refresh distress scores
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setGatesOpen((o) => !o)}
        >
          {gatesOpen ? "Hide" : "Show"} 7-gate discovery strategy
        </button>
      </div>

      {gatesOpen && gates.length ? (
        <ol className="sm-gates-list">
          {gates.map((g) => (
            <li key={g.id}>
              <strong>{g.title}</strong> — {g.detail}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
