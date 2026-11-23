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

type DrawerKind = "fundamental" | "management" | "valuation";

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
  valuation: {
    title: "Valuation parameters",
    label: "Valuation score",
    max: 6,
    src: "Peers = same industry (3+ with data) · cash: Yahoo",
  },
};

function tone(got: number, of: number): string {
  if (!of) return "na";
  const r = got / of;
  return r >= 0.7 ? "good" : r >= 0.4 ? "mid" : "bad";
}

/** Same thresholds as Portfolio review valuation pills. */
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
          : row.v_checks
      : [];
  const scoreVal =
    drawer && row
      ? drawer === "fundamental"
        ? row.fundamental
        : drawer === "management"
          ? row.management
          : row.valuation
      : null;

  return (
    <div className="napkin-sheet-section">
      <h2 className="napkin-block-title">Evaluation</h2>
      {err ? (
        <p className="qf-msg qf-msg--err">Could not score: {err}</p>
      ) : (
        <div className="nsc nsc--portfolio">
          <button
            type="button"
            className={`nsc-cell nsc-cell--${pending || !row?.scored ? "na" : tone(row.fundamental, 6)}`}
            onClick={() => row && row.scored > 0 && setDrawer("fundamental")}
            title="Fundamental checklist"
          >
            <span className="nsc-k">Fundamental score</span>
            <span className="nsc-pill">
              {pending || !row ? "…" : row.scored ? row.fundamental : "—"}
              <small>/ 6</small>
            </span>
          </button>
          <button
            type="button"
            className={`nsc-cell nsc-cell--${pending || !row?.m_scored ? "na" : tone(row.management, 5)}`}
            onClick={() => row && row.m_scored > 0 && setDrawer("management")}
            title="Management checklist"
          >
            <span className="nsc-k">Management score</span>
            <span className="nsc-pill">
              {pending || !row ? "…" : row.m_scored ? row.management : "—"}
              <small>/ 5</small>
            </span>
          </button>
          <div className="nsc-total">
            <span className="nsc-k">Quality score</span>
            <strong>
              {pending || !row ? "…" : row.quality}
              <small> / 11</small>
            </strong>
            <span className="nsc-sub">Fundamental + management</span>
          </div>
          <button
            type="button"
            className="nsc-cell"
            onClick={() => row && row.v_scored > 0 && setDrawer("valuation")}
            title="Valuation checklist · −4…+6"
          >
            <span className="nsc-k">Valuation score</span>
            <span
              className={`vx-score vx-score--val vx-score--${
                pending || !row?.v_scored ? "na" : valCls(row.valuation, row.v_scored)
              }`}
            >
              {pending || !row ? "…" : row.v_scored ? row.valuation : "—"}
            </span>
          </button>
          <div className="nsc-total">
            <span className="nsc-k">Total score</span>
            <strong>
              {pending || !row ? "…" : row.total}
              <small> / 17</small>
            </strong>
            <span className="nsc-sub">Quality + valuation</span>
          </div>
          <div
            className={`nsc-rating nsc-rating--${row ? ratingCls(row.rating) : "mid"}`}
          >
            <span className="nsc-k">Final rating</span>
            <strong>{pending || !row ? "…" : row.rating}</strong>
            <span className="nsc-sub">
              Excellent 13+ · Good 9+ · Average 5+ · Quality = F + M
            </span>
          </div>
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
