"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QuartersRankCard } from "@/components/QuartersRankCard";
import { QuoteTapeCard } from "@/components/QuoteTapeCard";
import { SevenRuleScoreCard } from "@/components/SevenRuleScoreCard";
import { QfCard } from "@/components/napkin/NapkinQualityFlags";
import type { QualityFlags } from "@/lib/napkin/quality-flags";
import type { QuarterRankResult } from "@/lib/quarter-rank";
import type { SevenRuleResult } from "@/lib/seven-rule-score";
import type { ExpandQuarterData } from "@/lib/use-expand-quarters";

/**
 * Score (first Napkin row; Evaluation /17 sits below): five scores, total /20.
 *
 *   Quality       /6   10/5/3-yr book value, EPS, sales CAGR, ROCE avg, promoter
 *   Momentum      /5   7 rules scaled to 5 — earnings/returns (not price)
 *   Quarters      /3   0–10 growth score scaled to 3 (overlaps Momentum → lighter)
 *   Red flags     /4   4 − penalties: pledge −2, interest cover −1, other income −1
 *   Special       +2   capex story / cash rich (bonus)
 *   Tech          info only (moving averages, 52-week position) — not in the total
 *
 * Rating: Excellent ≥ 15 · Good 11–14 · Average 7–10 · Poor ≤ 6.
 * Caps: promoter pledge → at most Good · 2+ red flags → at most Average ·
 *   quality ≤ 3/6 → at most Average (≤ 2/6 with ROCE failing → Poor).
 */

type Kind = "quality" | "momentum" | "quarters" | "flags" | "special" | "tech";
type Tape = { price: number | null; week52_low: number | null; week52_high: number | null; mas: Array<{ period: number; value: number | null }> };
type Rating = "Excellent" | "Good" | "Average" | "Poor";
const ORDER: Rating[] = ["Poor", "Average", "Good", "Excellent"];

function ratingFor(total: number): Rating {
  return total >= 15 ? "Excellent" : total >= 11 ? "Good" : total >= 7 ? "Average" : "Poor";
}
const capAt = (r: Rating, max: Rating): Rating => (ORDER.indexOf(r) > ORDER.indexOf(max) ? max : r);
/** Same colours as Portfolio review: ≥ 65% green · ≥ 40% amber · else red. */
const pr = (got: number, of: number) => (!of ? "na" : got / of >= 0.65 ? "good" : got / of >= 0.4 ? "mid" : "bad");

/** Each special situation as its own block with ✓ / ✗ conditions. */
function SpecialPanel({ checks }: { checks: QualityFlags["special"] }) {
  return (
    <div className="nsc-sp">
      {checks.map((c) => (
        <section key={c.id} className={`nsc-sp-card nsc-sp-card--${c.verdict}`}>
          <header>
            <strong>{c.label}</strong>
            <span className={`nsc-sp-badge nsc-sp-badge--${c.verdict}`}>
              {c.verdict === "pass" ? "Qualifies" : c.verdict === "na" ? "No data" : "Does not qualify"}
            </span>
          </header>
          {c.conds?.length ? (
            <ul>
              {c.conds.map((d) => (
                <li key={d.label} className={d.ok == null ? "na" : d.ok ? "ok" : "no"}>
                  <span className="nsc-sp-mark" aria-hidden>
                    {d.ok == null ? "–" : d.ok ? "✓" : "✗"}
                  </span>
                  <span className="nsc-sp-l">{d.label}</span>
                  <span className="nsc-sp-v">{d.value}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="qf-msg">{c.note ?? "No data"}</p>
          )}
        </section>
      ))}
      <p className="nsc-sp-foot">All conditions must hold. Capex story: growth from new capacity. Cash rich: market values the business below its net cash.</p>
    </div>
  );
}

export function NapkinScorecard({
  sevenRule,
  qrank,
  qtr,
  price,
  quality,
  qualityReady,
  ticker,
  market,
}: {
  sevenRule: SevenRuleResult | null;
  qrank: QuarterRankResult | null;
  qtr: ExpandQuarterData;
  price: number | null;
  quality: QualityFlags | null;
  qualityReady: boolean;
  ticker: string;
  market: string | null;
}) {
  const [open, setOpen] = useState<Kind | null>(null);
  const [tape, setTape] = useState<{ t: string; v: Tape | null } | null>(null);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ ticker: ticker.toUpperCase() });
    if (market) q.set("market", market);
    void fetch(`/api/quote-tape?${q}`, { signal: AbortSignal.timeout(60_000) })
      .then((r) => r.json())
      .then((j: { ok?: boolean; tape?: Tape }) => {
        if (live) setTape({ t: ticker, v: j.ok && j.tape ? j.tape : null });
      })
      .catch(() => {
        if (live) setTape({ t: ticker, v: null });
      });
    return () => {
      live = false;
    };
  }, [ticker, market]);
  const tp = tape && tape.t === ticker ? tape.v : null;
  const maAbove = tp?.price != null ? tp.mas.filter((m) => m.value != null && tp.price! > m.value).length : null;
  const maKnown = tp ? tp.mas.filter((m) => m.value != null).length : 0;
  const fromHigh = tp?.price != null && tp.week52_high ? (tp.price / tp.week52_high - 1) * 100 : null;
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  // ---- points ----
  const qScored = quality?.quality_scored ?? 0;
  const qPts = qScored ? Math.round(((quality!.quality_passed ?? 0) / qScored) * 6) : null;
  const mPts = sevenRule ? Math.round((sevenRule.passed / (sevenRule.rules.length || 7)) * 5) : null;
  const qrPts = qrank ? Math.round((qrank.score / 10) * 3) : null;
  const flagsKnown = quality ? quality.flags.filter((f) => f.verdict !== "na").length : 0;
  const raised = quality?.red_flags ?? 0;
  // Pledge is the serious one (forced selling risk): −2; others −1 each.
  const penalty = (quality?.flags ?? []).reduce((a, f) => a + (f.verdict === "fail" ? (f.id === "pledge" ? 2 : 1) : 0), 0);
  const fPts = quality && flagsKnown ? Math.max(0, 4 - penalty) : null;
  const sQual = quality?.special?.filter((c) => c.verdict === "pass") ?? [];
  const sPts = quality?.special?.length ? sQual.length : null;
  const parts = [qPts, mPts, qrPts, fPts, sPts];
  const total = parts.reduce<number>((a, v) => a + (v ?? 0), 0);
  const pending = !qualityReady || !sevenRule || !qrank;

  // ---- rating with analyst caps ----
  let rating = ratingFor(total);
  const caps: string[] = [];
  const pledge = quality?.flags.find((f) => f.id === "pledge");
  if (pledge?.verdict === "fail") {
    const r = capAt(rating, "Good");
    if (r !== rating) caps.push("promoter pledge");
    rating = r;
  }
  // Weak long-run quality can't be rescued by short-term 7-rule momentum.
  // "Poor" only when returns are weak too (no growth AND low ROCE); a high-ROCE
  // business that is merely growing slowly is capped at Average, not Poor.
  if (qPts != null && qPts <= 3) {
    const roceOk = quality?.quality.find((c) => c.id === "roce")?.verdict === "pass";
    const floor: Rating = qPts <= 2 && !roceOk ? "Poor" : "Average";
    const r = capAt(rating, floor);
    if (r !== rating) caps.push(`weak 10-yr ${roceOk ? "growth" : "quality"} (${qPts}/6)`);
    rating = r;
  }

  if (raised >= 2) {
    const r = capAt(rating, "Average");
    if (r !== rating) caps.push(`${raised} red flags`);
    rating = r;
  }

  const drawer: Record<Kind, { title: string; body: ReactNode }> = {
    quality: {
      title: "Quality checks · 10 / 5 / 3 years",
      body: quality ? (
        <QfCard
          checks={quality.quality}
          kind="quality"
          startOpen
          headline={
            <>
              <span className="seven-rule-score-num">{quality.quality_passed}</span>
              <span className="seven-rule-score-denom">/ {quality.quality_scored} checks</span>
            </>
          }
          rating={{ label: `${qPts ?? 0} / 6 pts`, cls: "seven-rule-rating--hold" }}
          sub="Book value, EPS & sales ≥ 10% CAGR · ROCE ≥ 10% avg · promoter steady"
        />
      ) : null,
    },
    momentum: { title: "Momentum · 7 rules", body: sevenRule ? <SevenRuleScoreCard result={sevenRule} /> : null },
    quarters: { title: "Quarters · growth score", body: <QuartersRankCard data={qtr} price={price} defaultExpanded /> },
    flags: {
      title: "Red flags",
      body: quality ? (
        <QfCard
          checks={quality.flags}
          kind="flag"
          startOpen
          headline={
            <>
              <span className="seven-rule-score-num">{raised}</span>
              <span className="seven-rule-score-denom">/ {quality.flags.length} raised</span>
            </>
          }
          rating={raised ? { label: "Watch", cls: "seven-rule-rating--sell" } : { label: "Clean", cls: "seven-rule-rating--buy" }}
          sub="Pledge < 1% · promoter ≥ 20% · other income < 10% of revenue · interest cover > 5×"
        />
      ) : null,
    },
    tech: {
      title: "Tech",
      body: <QuoteTapeCard ticker={ticker} market={market} hideTitle hideVal className="napkin-tape-card" />,
    },
    special: {
      title: "Special situations",
      body: quality?.special?.length ? <SpecialPanel checks={quality.special} /> : null,
    },
  };

  const rCls = rating === "Excellent" ? "top" : rating === "Good" ? "good" : rating === "Average" ? "mid" : "bad";
  return (
    <div className="napkin-sheet-section">
      <h2 className="napkin-block-title">Score</h2>
      <div className="napkin-vx vx-scroll">
        <table className="vx-table napkin-vx-table">
          <thead>
            <tr>
              <th className="num" title="10 / 5 / 3-yr growth, ROCE, promoter · click for checks">Quality</th>
              <th className="num" title="7 rules on earnings and returns · click for rules">Momentum</th>
              <th className="num" title="Quarterly growth score · click for detail">Quarters</th>
              <th className="num" title="4 minus penalties · click for flags">Red flags</th>
              <th className="num" title="Capex story / cash rich (bonus)">Special</th>
              <th className="num" title="Price above moving averages · not in the total">Tech</th>
              <th className="num">Total</th>
              <th>Final rating</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="num">
                <button type="button" className={`vx-score vx-score--${qPts == null ? "na" : pr(qPts, 6)}`} onClick={() => setOpen("quality")} title={quality ? `${quality.quality_passed}/${qScored} checks` : "Quality checks"}>
                  {qPts ?? "—"}
                  <small>/ 6</small>
                </button>
              </td>
              <td className="num">
                <button type="button" className={`vx-score vx-score--${mPts == null ? "na" : pr(mPts, 5)}`} onClick={() => setOpen("momentum")} title={sevenRule ? `${sevenRule.passed}/${sevenRule.rules.length} rules` : "Momentum rules"}>
                  {mPts ?? "—"}
                  <small>/ 5</small>
                </button>
              </td>
              <td className="num">
                <button type="button" className={`vx-score vx-score--${qrPts == null ? "na" : pr(qrPts, 3)}`} onClick={() => setOpen("quarters")} title={qrank ? `${qrank.score.toFixed(1)}/10 · ${qrank.band}` : "Quarters"}>
                  {qrPts ?? "—"}
                  <small>/ 3</small>
                </button>
              </td>
              <td className="num">
                <button
                  type="button"
                  className={`vx-score vx-score--${fPts == null ? "na" : raised === 0 ? "good" : raised === 1 ? "mid" : "bad"}`}
                  onClick={() => setOpen("flags")}
                  title={quality ? (raised ? `${raised} raised` : "clean") : "Red flags"}
                >
                  {fPts ?? "—"}
                  <small>/ 4</small>
                </button>
              </td>
              <td className="num">
                <button type="button" className={`vx-score vx-score--${sPts ? "good" : "na"}`} onClick={() => setOpen("special")} title={sQual.length ? sQual.map((c) => c.label).join(" · ") : "none"}>
                  {sPts == null ? "—" : `+${sPts}`}
                  <small>/ 2</small>
                </button>
              </td>
              <td className="num">
                <button
                  type="button"
                  className={`vx-score vx-score--${maAbove == null ? "na" : pr(maAbove, maKnown || 4)}`}
                  onClick={() => setOpen("tech")}
                  title={fromHigh == null ? "Tech · not in the total" : `${fromHigh >= -0.5 ? "at" : `${Math.round(fromHigh)}% from`} 52W high · not in the total`}
                >
                  {maAbove ?? "—"}
                  <small>/ {maKnown || 4}</small>
                </button>
              </td>
              <td className="num vx-total-cell">
                {pending ? "…" : total} <small>/ 20</small>
              </td>
              <td>
                <span
                  className={`vx-rating vx-rating--${pending ? "na" : rCls}`}
                  title={caps.length ? `capped: ${caps.join(", ")}` : "Excellent 15+ · Good 11+ · Average 7+"}
                >
                  {pending ? "…" : rating}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {open ? (
        <div className="nsc-drawer-wrap" onClick={() => setOpen(null)}>
          <aside className="nsc-drawer" role="dialog" aria-label={drawer[open].title} onClick={(e) => e.stopPropagation()}>
            <header className="nsc-drawer-head">
              <span>{drawer[open].title}</span>
              <button type="button" aria-label="Close" onClick={() => setOpen(null)}>
                ✕
              </button>
            </header>
            {drawer[open].body ?? <p className="qf-msg">No data for this stock yet.</p>}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
