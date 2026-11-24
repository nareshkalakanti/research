"use client";

import { useEffect, useState } from "react";

/**
 * Evaluation on Napkin (second row, below Score /20):
 * Fundamental /6 · Management /5 · Quality /11 · Valuation (−4…+6 cell, /6 drawer) · Total /17.
 * Matches Portfolio review labels, drawer score, and checklist layout.
 */

type FundCheck = {
  id: string;
  label: string;
  rule: string;
  value: string;
  points: number | null;
  note?: string;
};

type EvalRow = {
  t: string;
  fundamental: number;
  scored: number;
  checks: FundCheck[];
  management: number;
  m_scored: number;
  m_checks: FundCheck[];
  quality: number;
  valuation: number;
  v_scored: number;
  v_checks: FundCheck[];
  total: number;
  total_max: number;
  rating: "Excellent" | "Good" | "Average" | "Poor" | "No data";
};

type DrawerKind = "fundamental" | "management" | "quality" | "valuation";

/** Same labels / max as Portfolio review (drawer uses /6; cell shows −4…+6). */
const DRAWER: Record<
  DrawerKind,
  { title: string; label: string; max: number; src: string }
> = {
  fundamental: {
    title: "Fundamental parameters",
    label: "Fundamental score",
    max: 6,
    src: "Screener annual results (standalone when consolidated is stale)",
  },
  management: {
    title: "Management parameters",
    label: "Management score",
    max: 5,
    src: "Screener shareholding pattern (last 12 quarters)",
  },
  quality: {
    title: "Quality parameters",
    label: "Quality score",
    max: 11,
    src: "Fundamental (Screener annual results) + management (shareholding pattern)",
  },
  valuation: {
    title: "Valuation parameters",
    label: "Valuation score",
    max: 6,
    src: "Peers = same industry (3+ with data) · cash: Yahoo",
  },
};

/** Same thresholds as Portfolio review valuation pills. */
/** Same colours as Portfolio review: ≥ 65% green · ≥ 40% amber · else red. */
function pr(got: number, of: number): string {
  return !of ? "na" : got / of >= 0.65 ? "good" : got / of >= 0.4 ? "mid" : "bad";
}

function valCls(v: number, scored: number): string {
  if (!scored) return "na";
  return v >= 3 ? "good" : v >= 1 ? "mid" : "bad";
}

function ratingCls(r: EvalRow["rating"]): string {
  return r === "Excellent"
    ? "top"
    : r === "Good"
      ? "good"
      : r === "Average"
        ? "mid"
        : "bad";
}

export function NapkinPortfolioEval({ ticker }: { ticker: string }) {
  const t = ticker.trim().toUpperCase();
  const [row, setRow] = useState<EvalRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState<DrawerKind | null>(null);

  useEffect(() => {
    if (!t) return;
    let live = true;
    setLoading(true);
    setErr(null);
    setRow(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/portfolio-review?score=${encodeURIComponent(t)}`,
          { cache: "no-store" },
        );
        const j = (await res.json()) as {
          ok?: boolean;
          error?: string;
          row?: EvalRow;
        };
        if (!live) return;
        if (!res.ok || j.ok === false || !j.row) {
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        setRow(j.row);
        setErr(null);
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [t]);

  useEffect(() => {
    if (!drawer) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [drawer]);

  const pending = loading || (row != null && row.scored < 0);
  const checks =
    drawer && row
      ? drawer === "fundamental"
        ? row.checks
        : drawer === "management"
          ? row.m_checks
          : drawer === "quality"
            ? [...row.checks, ...row.m_checks]
            : row.v_checks
      : [];
  const scoreVal =
    drawer && row
      ? drawer === "fundamental"
        ? row.fundamental
        : drawer === "management"
          ? row.management
          : drawer === "quality"
            ? row.quality
            : row.valuation
      : null;

  return (
    <div className="napkin-sheet-section">
      <h2 className="napkin-block-title">Evaluation</h2>
      {err ? (
        <p className="qf-msg qf-msg--err">Could not score: {err}</p>
      ) : (
        <div className="napkin-vx vx-scroll">
          <table className="vx-table napkin-vx-table napkin-vx-table--6">
            <thead>
              <tr>
                <th className="num" title="Click a score for the checklist">Fundamental score</th>
                <th className="num" title="Click a score for the checklist">Management score</th>
                <th className="num" title="Fundamental + management">Quality score</th>
                <th className="num" title="Valuation checklist · range −4…+6">Valuation score</th>
                <th className="num" title="Quality + valuation">Total score</th>
                <th>Final rating</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                {pending || !row ? (
                  <td colSpan={6} className="vx-empty">
                    Scoring…
                  </td>
                ) : (
                  <>
                    <td className="num">
                      <button
                        type="button"
                        className={`vx-score vx-score--${pr(row.fundamental, row.scored)}`}
                        onClick={() => row.scored > 0 && setDrawer("fundamental")}
                        title="Show the fundamental checklist"
                      >
                        {row.scored ? row.fundamental : "—"}
                        <small>/ 6</small>
                      </button>
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className={`vx-score vx-score--${pr(row.management, row.m_scored)}`}
                        onClick={() => row.m_scored > 0 && setDrawer("management")}
                        title="Show the management checklist"
                      >
                        {row.m_scored ? row.management : "—"}
                        <small>/ 5</small>
                      </button>
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className={`vx-score vx-score--${pr(row.quality, row.scored + row.m_scored ? 11 : 0)}`}
                        onClick={() => row.scored + row.m_scored > 0 && setDrawer("quality")}
                        title="Show the fundamental + management checklist"
                      >
                        {row.scored + row.m_scored ? row.quality : "—"}
                        <small>/ 11</small>
                      </button>
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className={`vx-score vx-score--val vx-score--${valCls(row.valuation, row.v_scored)}`}
                        onClick={() => row.v_scored > 0 && setDrawer("valuation")}
                        title="Valuation checklist · −4…+6"
                      >
                        {row.v_scored ? row.valuation : "—"}
                      </button>
                    </td>
                    <td className="num vx-total-cell">
                      {row.total} <small>/ 17</small>
                    </td>
                    <td>
                      <span className={`vx-rating vx-rating--${ratingCls(row.rating)}`} title="Excellent 13+ · Good 9+ · Average 5+">
                        {row.rating}
                      </span>
                    </td>
                  </>
                )}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {drawer && row ? (
        <div className="nsc-drawer-wrap" onClick={() => setDrawer(null)}>
          <aside
            className="nsc-drawer"
            role="dialog"
            aria-label={DRAWER[drawer].title}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="nsc-drawer-head">
              <span>{DRAWER[drawer].title}</span>
              <button type="button" aria-label="Close" onClick={() => setDrawer(null)}>
                ✕
              </button>
            </header>
            <div className="vx-drawer-score">
              <span>{DRAWER[drawer].label}</span>
              <strong>
                {scoreVal}
                <small> / {DRAWER[drawer].max}</small>
              </strong>
            </div>
            <span className="vx-label vx-drawer-k">Detailed checks checklist</span>
            <ul className="vx-checks">
              {checks.map((c) => (
                <li key={c.id}>
                  <div>
                    <strong>{c.label}</strong>
                    <span className="vx-hint">
                      {c.rule} · <b>{c.value}</b>
                    </span>
                    {c.note ? <span className="vx-hint">{c.note}</span> : null}
                  </div>
                  <span
                    className={`vx-pt vx-pt--${c.points == null ? "na" : c.points > 0 ? "yes" : c.points < 0 ? "neg" : "no"}`}
                  >
                    {c.points == null ? "n/a" : c.points > 0 ? `+${c.points}` : String(c.points)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="vx-hint">
              {DRAWER[drawer].src} · points as shown per check
              {drawer === "valuation" ? " · range −4…+6" : ""}
            </p>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
