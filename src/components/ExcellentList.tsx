"use client";

import { useEffect, useState } from "react";
import { napkinUrl, tradingviewUrl } from "@/lib/links";
import {
  REVIEW_SCORE_HEADERS,
  ReviewScoreCells,
  ReviewScoreDrawer,
  type ReviewDrawerKind,
  type ReviewScoreRow,
} from "@/components/ReviewScores";

type Row = ReviewScoreRow & { mcap: number | null; owned: boolean };
type Payload = {
  ok: boolean;
  error?: string;
  rows: Row[];
  universe: number;
  scored: number;
  missing: number;
  rules: { min_mcap_cr: number; min_roce: number };
  job: { running: boolean } | null;
  screener_paused_until: string | null;
};

const cr = (v: number | null) => (v == null ? "—" : `₹${Math.round(v).toLocaleString("en-IN")} Cr`);

/**
 * Portfolio page: every stock rated Excellent (total 13+ of 17) among
 * ₹200 Cr+ / ROCE 15%+ companies. Scoring runs slowly in the background.
 */
export function ExcellentList() {
  const [data, setData] = useState<Payload | null>(null);
  const [poll, setPoll] = useState(0);
  const [drawer, setDrawer] = useState<{ row: ReviewScoreRow; kind: ReviewDrawerKind } | null>(null);
  const [hideOwned, setHideOwned] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch("/api/excellent", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Payload) => {
        if (live) setData(j);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [poll]);
  // Refresh every 30 s while stocks are still being scored.
  useEffect(() => {
    if (!data?.missing) return;
    const t = setTimeout(() => setPoll((n) => n + 1), 30_000);
    return () => clearTimeout(t);
  }, [data]);

  if (!data) return <div className="vx-card vx-empty">Loading Excellent list…</div>;
  if (!data.ok) return <div className="vx-card vx-empty vx-msg--err">Could not load: {data.error}</div>;

  const rows = hideOwned ? data.rows.filter((r) => !r.owned) : data.rows;
  const pct = data.universe ? Math.round((data.scored / data.universe) * 100) : 0;
  const left = data.missing;
  const running = !!data.job?.running;

  return (
    <div className="vx-card xl-card">
      <div className="xl-head">
        <div>
          <span className="vx-label vx-label--title">Excellent stocks</span>
          <p className="vx-hint">
            Rated Excellent (13+ of 17) on the same checks as your portfolio · companies ₹{data.rules.min_mcap_cr} Cr+ with ROCE{" "}
            {data.rules.min_roce}%+ · <b>{data.rows.length}</b> found in {data.scored} scored
          </p>
        </div>
        <label className="xl-toggle">
          <input type="checkbox" checked={hideOwned} onChange={(e) => setHideOwned(e.target.checked)} /> Hide stocks I own
        </label>
      </div>

      {left > 0 ? (
        <div className="wl-score-progress" role="status">
          <div className="wl-score-progress-head">
            <span>
              <b>Scoring</b> {data.scored} of {data.universe}
            </span>
            <span className="wl-score-progress-note">
              {data.screener_paused_until
                ? `Screener paused until ${new Date(data.screener_paused_until).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}: resumes after`
                : running
                  ? `${left} left · about 2 a minute (~${left >= 120 ? `${Math.round(left / 120)} h` : `${Math.max(1, Math.round(left / 2))} min`}) · Watchlist stocks go first`
                  : `${left} not scored yet`}
            </span>
          </div>
          <div className={`wl-score-bar${running ? " wl-score-bar--run" : ""}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : null}

      <div className="vx-scroll">
        <table className="vx-table">
          <thead>
            <tr>
              <th>Company name</th>
              <th className="num">Market cap</th>
              {REVIEW_SCORE_HEADERS.map((h) => (
                <th key={h.label} className={h.num ? "num" : undefined} title={h.title}>
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr>
                <td colSpan={8} className="vx-empty">
                  {data.rows.length ? "You own every Excellent stock found so far." : "No Excellent stocks yet — they appear here as scoring runs."}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.t}>
                  <td>
                    <a className="vx-co" href={tradingviewUrl(r.t, r.market)} target="_blank" rel="noopener noreferrer">
                      {r.name}
                    </a>
                    <span className="vx-sub">
                      {r.t}
                      {r.market !== "NSE" ? <em>{r.market}</em> : null}
                      {r.industry ? <span className="xl-ind">{r.industry}</span> : null}
                      <a className="np-chip" href={napkinUrl(r.t)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                        NP
                      </a>
                      {r.owned ? <span className="xl-owned">Owned</span> : null}
                    </span>
                  </td>
                  <td className="num">{cr(r.mcap)}</td>
                  <ReviewScoreCells r={r} onOpen={(row, kind) => setDrawer({ row, kind })} />
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <ReviewScoreDrawer drawer={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
