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
 * Napkin scorecard: one row, five scores, a total out of 20 and a final rating.
 *
 *   Quality       /6   10/5/3-yr book value, EPS, sales CAGR, ROCE avg, promoter
 *   Momentum      /5   7 rules scaled to 5 (ROCE, ROE, QoQ / YoY sales & profit, margin)
 *   Quarters      /3   0–10 growth score scaled to 3 (overlaps Momentum → lighter)
 *   Red flags     /4   4 − penalties: pledge −2, interest cover −1, other income −1
 *   Special       +2   capex story / cash rich (bonus)
 *   Tech          info only (moving averages, 52-week position) — not in the total
 *
 * Rating: Excellent ≥ 15 · Good 11–14 · Average 7–10 · Poor ≤ 6.
 * Caps: promoter pledge → at most Good · 2+ red flags → at most Average.
 */

type Kind = "quality" | "momentum" | "quarters" | "flags" | "special" | "tech";
type Tape = { price: number | null; week52_low: number | null; week52_high: number | null; mas: Array<{ period: number; value: number | null }> };
type Rating = "Excellent" | "Good" | "Average" | "Poor";
const ORDER: Rating[] = ["Poor", "Average", "Good", "Excellent"];

function ratingFor(total: number): Rating {
  return total >= 15 ? "Excellent" : total >= 11 ? "Good" : total >= 7 ? "Average" : "Poor";
}
const capAt = (r: Rating, max: Rating): Rating => (ORDER.indexOf(r) > ORDER.indexOf(max) ? max : r);
const tone = (got: number, of: number) => (!of ? "na" : got / of >= 0.7 ? "good" : got / of >= 0.4 ? "mid" : "bad");

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

function Cell({
  kind,
  label,
  value,
  of,
  sub,
  cls,
  onOpen,
}: {
  kind: Kind;
  label: string;
  value: number | null;
  of: string;
  sub: string;
  cls: string;
  onOpen: (k: Kind) => void;
}) {
  return (
    <button type="button" className={`nsc-cell nsc-cell--${cls}`} onClick={() => onOpen(kind)} title={`${label}: open the checklist`}>
      <span className="nsc-k">{label}</span>
      <span className="nsc-pill">
        {value == null ? "—" : value}
        <small>{of}</small>
      </span>
      <span className="nsc-sub">{sub}</span>
    </button>
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
  // Weak long-run quality can't be rescued by short-term momentum.
  if (qPts != null && qPts <= 3) {
    const r = capAt(rating, qPts <= 2 ? "Poor" : "Average");
    if (r !== rating) caps.push(`weak 10-yr quality (${qPts}/6)`);
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
      <h2 className="napkin-block-title">Scorecard</h2>
      <div className="nsc">
        <Cell onOpen={setOpen} kind="quality" label="Quality" value={qPts} of="/ 6" cls={qPts == null ? "na" : tone(qPts, 6)} sub={quality ? `${quality.quality_passed}/${qScored} checks` : qualityReady ? "no data" : "loading…"} />
        <Cell onOpen={setOpen} kind="momentum" label="Momentum" value={mPts} of="/ 5" cls={mPts == null ? "na" : tone(mPts, 5)} sub={!sevenRule ? "—" : `${sevenRule.passed}/${sevenRule.rules.length} rules${sevenRule.ratingLabel && sevenRule.ratingLabel !== "No" ? ` · ${sevenRule.ratingLabel}` : ""}`} />
        <Cell onOpen={setOpen} kind="quarters" label="Quarters" value={qrPts} of="/ 3" cls={qrPts == null ? "na" : tone(qrPts, 3)} sub={qrank ? `${qrank.score.toFixed(1)}/10 · ${qrank.band}` : "—"} />
        <Cell onOpen={setOpen} kind="flags" label="Red flags" value={fPts} of="/ 4" cls={fPts == null ? "na" : raised === 0 ? "good" : raised === 1 ? "mid" : "bad"} sub={quality ? (raised ? `${raised} raised` : "clean") : qualityReady ? "no data" : "loading…"} />
        <Cell onOpen={setOpen} kind="special" label="Special" value={sPts == null ? null : sPts} of="+ 2" cls={sPts ? "good" : "na"} sub={sQual.length ? sQual.map((c) => c.label).join(" · ") : quality ? "none" : "loading…"} />
        <button type="button" className="nsc-cell nsc-cell--info" onClick={() => setOpen("tech")} title="Tech: not counted in the total">
          <span className="nsc-k">Tech</span>
          <span className="nsc-pill">
            {maAbove == null ? "—" : maAbove}
            <small>/ {maKnown || 4} MAs</small>
          </span>
          <span className="nsc-sub">
            {fromHigh == null ? (tape ? "no price data" : "loading…") : `${fromHigh >= -0.5 ? "at" : `${Math.round(fromHigh)}% from`} 52W high`}
          </span>
        </button>
        <div className="nsc-total">
          <span className="nsc-k">Total</span>
          <strong>
            {total}
            <small> / 20</small>
          </strong>
          <span className="nsc-sub">{pending ? "still loading…" : "quality-weighted"}</span>
        </div>
        <div className={`nsc-rating nsc-rating--${rCls}`}>
          <span className="nsc-k">Final rating</span>
          <strong>{pending ? "…" : rating}</strong>
          <span className="nsc-sub">{caps.length ? `capped: ${caps.join(", ")}` : "Excellent 15+ · Good 11+ · Average 7+"}</span>
        </div>
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
