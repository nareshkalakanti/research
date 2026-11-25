"use client";

import { useEffect } from "react";

/**
 * Portfolio-review score cells (Fundamental · Management · Quality · Valuation ·
 * Total · Final rating) and the checklist drawer, as on the Portfolio page.
 * Wrap in `.napkin-vx` (theme-aware vx colours) outside the Portfolio page.
 */

export type ReviewCheck = { id: string; label: string; rule: string; value: string; points: number | null; note?: string };
export type ReviewScoreRow = {
  t: string;
  name: string;
  market: string;
  industry: string | null;
  fundamental: number;
  scored: number;
  checks: ReviewCheck[];
  management: number;
  m_scored: number;
  m_checks: ReviewCheck[];
  quality: number;
  valuation: number;
  v_scored: number;
  v_checks: ReviewCheck[];
  total: number;
  total_max: number;
  rating: "Excellent" | "Good" | "Average" | "Poor" | "Incomplete" | "No data";
  added_at?: string;
};
export type ReviewDrawerKind = "fundamental" | "management" | "quality" | "valuation";

const DRAWER: Record<ReviewDrawerKind, { title: string; label: string; max: number; src: string }> = {
  fundamental: { title: "Fundamental parameters", label: "Fundamental score", max: 6, src: "Screener annual results (consolidated)" },
  management: { title: "Management parameters", label: "Management score", max: 5, src: "Screener shareholding pattern (last 12 quarters)" },
  quality: { title: "Quality parameters", label: "Quality score", max: 11, src: "Fundamental (Screener annual results) + management (shareholding pattern)" },
  valuation: { title: "Valuation parameters", label: "Valuation score", max: 6, src: "Peers = same industry (3+ with data) · cash: Yahoo" },
};

/** Colour by share of checks passed: ≥ 65% green · ≥ 40% amber · else red. */
const cls = (got: number, of: number) => (!of ? "na" : got / of >= 0.65 ? "good" : got / of >= 0.4 ? "mid" : "bad");
const ratingCls = (r: ReviewScoreRow) =>
  r.rating === "Excellent" ? "top" : r.rating === "Good" ? "good" : r.rating === "Average" ? "mid" : r.rating === "Poor" ? "bad" : "na";
const valCls = (v: number, n: number) => (!n ? "na" : v >= 3 ? "good" : v >= 1 ? "mid" : "bad");

export const REVIEW_SCORE_HEADERS: Array<{ label: string; title: string; num: boolean }> = [
  { label: "Fundamental score", title: "Out of 6: book value, sales, ROCE, interest cover, capex, other income", num: true },
  { label: "Management score", title: "Out of 5: shareholding checks", num: true },
  { label: "Quality score", title: "Fundamental + management, out of 11", num: true },
  { label: "Valuation score", title: "−4 to +6", num: true },
  { label: "Total score", title: "Quality + valuation, out of 17", num: true },
  { label: "Final rating", title: "Excellent 13+ · Good 9–12 · Average 5–8 · Poor ≤ 4", num: false },
];

/** Six <td>s. `r` missing = not scored yet (`pending` text in the first cell). */
export function ReviewScoreCells({
  r,
  pending,
  onOpen,
}: {
  r: ReviewScoreRow | null | undefined;
  pending?: string;
  onOpen: (row: ReviewScoreRow, kind: ReviewDrawerKind) => void;
}) {
  if (!r || r.scored < 0) {
    return (
      <>
        <td className="num">
          <span className="vx-hint">{pending ?? "Scoring…"}</span>
        </td>
        <td />
        <td />
        <td />
        <td />
        <td />
      </>
    );
  }
  return (
    <>
      <td className="num">
        <button
          type="button"
          className={`vx-score vx-score--${cls(r.fundamental, r.scored)}`}
          onClick={() => onOpen(r, "fundamental")}
          title="Show the fundamental checklist"
        >
          {r.scored ? r.fundamental : "—"}
          <small>/ 6</small>
        </button>
      </td>
      <td className="num">
        <button
          type="button"
          className={`vx-score vx-score--${cls(r.management, r.m_scored)}`}
          onClick={() => onOpen(r, "management")}
          title="Show the management checklist"
        >
          {r.m_scored ? r.management : "—"}
          <small>/ 5</small>
        </button>
      </td>
      <td className="num">
        <button
          type="button"
          className={`vx-score vx-score--${cls(r.quality, r.scored + r.m_scored)}`}
          onClick={() => onOpen(r, "quality")}
          title="Show the fundamental + management checklist"
        >
          {r.scored + r.m_scored ? r.quality : "—"}
          <small>/ 11</small>
        </button>
      </td>
      <td className="num">
        <button
          type="button"
          className={`vx-score vx-score--val vx-score--${valCls(r.valuation, r.v_scored)}`}
          onClick={() => onOpen(r, "valuation")}
          title="Valuation checklist · −4…+6"
        >
          {r.v_scored ? r.valuation : "—"}
        </button>
      </td>
      <td className="num vx-total-cell">
        {r.total} <small>/ 17</small>
      </td>
      <td>
        <span className={`vx-rating vx-rating--${ratingCls(r)}`}>{r.rating}</span>
      </td>
    </>
  );
}

/** The checklist drawer for one score. */
export function ReviewScoreDrawer({
  drawer,
  onClose,
}: {
  drawer: { row: ReviewScoreRow; kind: ReviewDrawerKind } | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!drawer) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [drawer, onClose]);
  if (!drawer) return null;
  const { row, kind } = drawer;
  const list =
    kind === "fundamental" ? row.checks : kind === "management" ? row.m_checks : kind === "quality" ? [...row.checks, ...row.m_checks] : row.v_checks;
  return (
    <div className="vx-drawer-wrap napkin-vx" onClick={onClose}>
      <aside className="vx-drawer" role="dialog" aria-label={`${row.name} ${kind} checks`} onClick={(e) => e.stopPropagation()}>
        <header className="vx-drawer-head">
          <span className="vx-eyebrow">{DRAWER[kind].title}</span>
          <button type="button" className="vx-drawer-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <h3 className="vx-drawer-title">{row.name}</h3>
        <p className="vx-hint">
          {row.market}: {row.t}
          {row.industry ? ` · ${row.industry}` : ""}
        </p>
        <div className="vx-drawer-score">
          <span>{DRAWER[kind].label}</span>
          <strong>
            {kind === "fundamental" ? row.fundamental : kind === "management" ? row.management : kind === "quality" ? row.quality : row.valuation}
            <small> / {DRAWER[kind].max}</small>
          </strong>
        </div>
        <span className="vx-label vx-drawer-k">Detailed checks checklist</span>
        <ul className="vx-checks">
          {list.map((c) => (
            <li key={c.id}>
              <div>
                <strong>{c.label}</strong>
                <span className="vx-hint">
                  {c.rule} · <b>{c.value}</b>
                </span>
                {c.note ? <span className="vx-hint">{c.note}</span> : null}
              </div>
              <span className={`vx-pt vx-pt--${c.points == null ? "na" : c.points > 0 ? "yes" : c.points < 0 ? "neg" : "no"}`}>
                {c.points == null ? "n/a" : c.points > 0 ? `+${c.points}` : String(c.points)}
              </span>
            </li>
          ))}
        </ul>
        <p className="vx-hint">{DRAWER[kind].src} · points as shown per check</p>
      </aside>
    </div>
  );
}
