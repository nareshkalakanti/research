"use client";

import { useEffect, useState } from "react";
import type { QfCheck, QualityFlags } from "@/lib/napkin/quality-flags";

/** Quality checks + red flags + special situations for one stock (Screener / Yahoo). */
export function useQualityFlags(ticker: string): { q: QualityFlags | null; ready: boolean; err: string | null } {
  const [data, setData] = useState<QualityFlags | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Do not AbortController.abort() on cleanup — Next's overlay reports that as
    // "signal is aborted without reason" (same pattern as ConcallDriftPanel).
    void (async () => {
      try {
        const res = await fetch(`/api/napkin/quality?ticker=${encodeURIComponent(ticker)}`, {
          cache: "no-store",
        });
        const j = (await res.json()) as { ok?: boolean; error?: string } & Partial<QualityFlags>;
        if (!live) return;
        if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
        setErr(null);
        setData(j as QualityFlags);
        setLoadedFor(ticker);
      } catch (e) {
        if (!live) return;
        setErr(e instanceof Error ? e.message : String(e));
        setLoadedFor(ticker);
      }
    })();
    return () => {
      live = false;
    };
  }, [ticker]);
  const ready = loadedFor === ticker;
  return { q: ready ? data : null, ready, err: ready ? err : null };
}

/** Napkin card: 10-year quality checks + red flags (Screener data). */
export function NapkinQualityFlags({ ticker }: { ticker: string }) {
  const { q: data, ready: loaded, err } = useQualityFlags(ticker);
  const loadedFor = loaded ? ticker : null;
  const ready = loadedFor === ticker;
  const q = ready ? data : null;
  const noData = q && q.quality_scored === 0 && q.flags.every((f) => f.verdict === "na");

  return (
    <>
      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">Quality checks · 10 / 5 / 3 years</h2>
        {!ready ? (
          <p className="qf-msg">Reading 10 years of results…</p>
        ) : err ? (
          <p className="qf-msg qf-msg--err">Could not load: {err}</p>
        ) : !q || noData ? (
          <p className="qf-msg">No Screener history for this stock yet.</p>
        ) : (
          <QfCard
            checks={q.quality}
            kind="quality"
            headline={
              <>
                <span className="seven-rule-score-num">{q.quality_passed}</span>
                <span className="seven-rule-score-denom">/ {q.quality_scored} checks</span>
              </>
            }
            rating={
              !q.quality_scored
                ? { label: "No data", cls: "seven-rule-rating--hold" }
                : q.quality_passed === q.quality_scored
                ? { label: "Strong", cls: "seven-rule-rating--buy" }
                : q.quality_passed >= Math.ceil(q.quality_scored * 0.6)
                  ? { label: "Mixed", cls: "seven-rule-rating--hold" }
                  : { label: "Weak", cls: "seven-rule-rating--sell" }
            }
            sub={`Book value, EPS & sales ≥ 10% CAGR · ROCE ≥ 10% avg · promoter steady${q.as_of ? ` · to FY${q.as_of.slice(0, 4)}` : ""}`}
          />
        )}
      </div>
      {!ready ? (
        <>
          <div className="napkin-sheet-section">
            <h2 className="napkin-block-title">Red flags</h2>
            <p className="qf-msg">Checking pledge, turnover and interest cover…</p>
          </div>
          <div className="napkin-sheet-section">
            <h2 className="napkin-block-title">Special situations</h2>
            <p className="qf-msg">Checking capex story and cash rich…</p>
          </div>
        </>
      ) : null}
      {ready && q && !noData ? (
        <div className="napkin-sheet-section">
          <h2 className="napkin-block-title">Red flags</h2>
          <QfCard
            checks={q.flags}
            kind="flag"
            headline={
              <>
                <span className="seven-rule-score-num">{q.red_flags}</span>
                <span className="seven-rule-score-denom">/ {q.flags.length} raised</span>
              </>
            }
            rating={q.red_flags ? { label: "Watch", cls: "seven-rule-rating--sell" } : { label: "Clean", cls: "seven-rule-rating--buy" }}
            sub="Pledge < 1% · promoter ≥ 20% · other income < 10% of revenue · interest cover > 5×"
          />
        </div>
      ) : null}
      {ready && q && !noData && q.special?.length ? (
        <div className="napkin-sheet-section">
          <h2 className="napkin-block-title">Special situations</h2>
          <QfCard
            checks={q.special}
            kind="special"
            headline={
              <>
                <span className="seven-rule-score-num">{q.special.filter((c) => c.verdict === "pass").length}</span>
                <span className="seven-rule-score-denom">/ {q.special.length} qualify</span>
              </>
            }
            rating={
              q.special.some((c) => c.verdict === "pass")
                ? { label: q.special.filter((c) => c.verdict === "pass").map((c) => c.label).join(" · "), cls: "seven-rule-rating--buy" }
                : { label: "None", cls: "seven-rule-rating--hold" }
            }
            sub="Capex story: net block > 2× last year · promoter > 40% · mcap > ₹150 Cr  |  Cash rich: cash − debt > mcap · promoter > 45% · pledge 0"
          />
        </div>
      ) : null}
    </>
  );
}

/** Momentum / Quarters card style: score line, segments, Show checks. */
export function QfCard({
  checks,
  kind,
  headline,
  rating,
  sub,
  startOpen,
}: {
  checks: QfCheck[];
  kind: "quality" | "flag" | "special";
  headline: React.ReactNode;
  rating: { label: string; cls: string };
  sub: string;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!startOpen);
  // Segments: for red flags a raised flag is the bad state.
  const seg = (c: QfCheck) => (c.verdict === "na" ? "unknown" : c.verdict);
  return (
    <div className={`seven-rule-card${open ? "" : " seven-rule-card--compact"}`}>
      <div className="seven-rule-head">
        <div className="seven-rule-score-line">
          {headline}
          <span className={`seven-rule-rating ${rating.cls}`}>{rating.label}</span>
        </div>
        <div className="seven-rule-segs" aria-hidden>
          {checks.map((c) => (
            <span key={c.id} title={`${c.label}: ${c.value}`} className={`seven-rule-seg seven-rule-seg--${seg(c)}`} />
          ))}
        </div>
        <p className="seven-rule-sub">{sub}</p>
      </div>
      {open ? (
        <ul className="seven-rule-rules">
          {checks.map((c) => (
            <QfRow key={c.id} c={c} kind={kind} />
          ))}
        </ul>
      ) : null}
      <button type="button" className="quarters-rank-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide checks" : "Show checks"}
      </button>
    </div>
  );
}

export function QfRow({ c, kind }: { c: QfCheck; kind: "quality" | "flag" | "special" }) {
  const label =
    c.verdict === "na"
      ? "N/A"
      : kind === "flag"
        ? c.verdict === "fail"
          ? "Red flag"
          : "OK"
        : kind === "special"
          ? c.verdict === "pass"
            ? "Yes"
            : "No"
          : c.verdict === "pass"
            ? "Pass"
            : "Fail";
  const cls = c.verdict === "pass" ? "seven-rule-rule--pass" : c.verdict === "fail" ? "seven-rule-rule--fail" : "seven-rule-rule--unknown";
  return (
    <li className={`seven-rule-rule ${cls}`} title={c.note}>
      <span className="seven-rule-rule-label">
        {c.label}
        {c.note ? <span className="qf-note">{c.note}</span> : null}
      </span>
      <span className="seven-rule-rule-val">
        {c.value}
        <span className="seven-rule-rule-thresh"> ({c.rule})</span>
      </span>
      <span className="seven-rule-rule-verdict">{label}</span>
    </li>
  );
}
