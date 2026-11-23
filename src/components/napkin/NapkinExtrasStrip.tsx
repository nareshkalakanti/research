"use client";

import { useEffect, useMemo, useState } from "react";
import type { NapkinCorpAction, NapkinExtras } from "@/lib/napkin/extras-types";

function fmtCr(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `${(v / 1000).toFixed(1)}k Cr`;
  if (abs >= 10) return `${v.toFixed(0)} Cr`;
  return `${v.toFixed(1)} Cr`;
}

function fmtRatio(r: string | null): string | null {
  if (!r) return null;
  return r.replace(/→/g, " → ").replace(/:/g, " : ").replace(/\s+/g, " ").trim();
}

type ContextRating = "Strong" | "Steady" | "Watch" | "Weak";

/** Generic signal from promoter / cash / other-income / street — not the /20 score. */
function contextRating(d: NapkinExtras): {
  rating: ContextRating;
  cls: "top" | "good" | "mid" | "bad";
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];

  if (d.other_income_pct != null) {
    if (d.other_income_pct >= 10) {
      score -= 2;
      reasons.push(`other income ${d.other_income_pct.toFixed(1)}% of revenue`);
    } else if (d.other_income_pct <= 3) {
      score += 1;
      reasons.push("other income clean");
    }
  }

  if (d.promoter_delta_pp != null) {
    if (d.promoter_delta_pp <= -2) {
      score -= 2;
      reasons.push(`promoter ${d.promoter_delta_pp.toFixed(1)} pp`);
    } else if (d.promoter_delta_pp >= 1) {
      score += 1;
      reasons.push(`promoter +${d.promoter_delta_pp.toFixed(1)} pp`);
    } else {
      reasons.push("promoter steady");
    }
  } else if (d.promoter[0]) {
    reasons.push(`promoter ${d.promoter[0].pct.toFixed(1)}%`);
  }

  if (d.ocf_trend === "rising") {
    score += 1;
    reasons.push("OCF rising");
  } else if (d.ocf_trend === "falling") {
    score -= 1;
    reasons.push("OCF falling");
  }
  if (d.ocf[0] && d.ocf[0].value < 0) {
    score -= 1;
    reasons.push("OCF negative");
  }

  if (d.analyst) {
    const { consensus, total } = d.analyst;
    if (/^buy$/i.test(consensus) || /lean buy/i.test(consensus)) {
      score += 1;
      reasons.push(`street ${consensus} (n=${total})`);
    } else if (/sell/i.test(consensus)) {
      score -= 2;
      reasons.push(`street ${consensus} (n=${total})`);
    } else {
      reasons.push(`street ${consensus} (n=${total})`);
    }
  }

  if (score >= 2) return { rating: "Strong", cls: "top", reasons };
  if (score >= 0) return { rating: "Steady", cls: "good", reasons };
  if (score >= -2) return { rating: "Watch", cls: "mid", reasons };
  return { rating: "Weak", cls: "bad", reasons };
}

function actionLine(a: NapkinCorpAction): string {
  const bits = [
    fmtRatio(a.ratio),
    a.amount != null ? `₹${a.amount}` : null,
    a.expiry_date,
    a.detail,
  ].filter(Boolean);
  return bits.join(" · ");
}

/** Corp actions · other-income · promoter · OCF · analysts (context only). */
export function NapkinExtrasStrip({ ticker }: { ticker: string }) {
  const [data, setData] = useState<NapkinExtras | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setReady(false);
    setErr(null);
    setActionsOpen(false);
    void (async () => {
      try {
        const res = await fetch(`/api/napkin/extras?ticker=${encodeURIComponent(ticker)}`, {
          cache: "no-store",
        });
        const j = (await res.json()) as { ok?: boolean; error?: string } & Partial<NapkinExtras>;
        if (!live) return;
        if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
        setData(j as NapkinExtras);
        setReady(true);
      } catch (e) {
        if (!live) return;
        setErr(e instanceof Error ? e.message : String(e));
        setData(null);
        setReady(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [ticker]);

  const empty =
    ready &&
    data &&
    !data.corp_actions.length &&
    data.other_income_pct == null &&
    !data.promoter.length &&
    !data.ocf.length &&
    !data.analyst;

  const ctx = useMemo(() => (data ? contextRating(data) : null), [data]);

  if (!ready) {
    return (
      <div className="napkin-sheet-section napkin-extras">
        <h2 className="napkin-block-title">Corp actions · Promoter · Cash · Analysts</h2>
        <p className="qf-msg">Loading from Upstox / IndianAPI…</p>
      </div>
    );
  }

  if (err || empty) {
    return (
      <div className="napkin-sheet-section napkin-extras">
        <h2 className="napkin-block-title">Corp actions · Promoter · Cash · Analysts</h2>
        <p className="qf-msg">{err ? `Could not load: ${err}` : "No Upstox / analyst extras for this name yet."}</p>
      </div>
    );
  }

  const d = data!;
  const promNewest = d.promoter[0];
  const promNote =
    promNewest == null
      ? null
      : d.promoter_delta_pp == null
        ? `${promNewest.pct.toFixed(1)}%`
        : `${promNewest.pct.toFixed(1)}% (${d.promoter_delta_pp >= 0 ? "+" : ""}${d.promoter_delta_pp.toFixed(1)} pp)`;
  const latestAction = d.corp_actions[0] ?? null;

  return (
    <div className="napkin-sheet-section napkin-extras">
      <div className="napkin-extras-head">
        <div>
          <h2 className="napkin-block-title">Corp actions · Promoter · Cash · Analysts</h2>
          <p className="napkin-extras-sub">
            Other income · promoter holding · operating cash flow · street consensus
            {d.source && d.source !== "none" ? ` · ${d.source}` : ""}
          </p>
        </div>
        {ctx ? (
          <div className={`nsc-rating nsc-rating--${ctx.cls} napkin-extras-rating`} title={ctx.reasons.join(" · ")}>
            <span className="nsc-k">Context rating</span>
            <strong>{ctx.rating}</strong>
          </div>
        ) : null}
      </div>

      <div className="napkin-extras-grid">
        {d.other_income_pct != null ? (
          <div className="napkin-extras-card">
            <div className="napkin-extras-label">Other income</div>
            <div className={`napkin-extras-value ${d.other_income_pct >= 10 ? "is-warn" : ""}`}>
              {d.other_income_pct.toFixed(1)}%
            </div>
            <div className="napkin-extras-meta">
              of revenue{d.other_income_period ? ` · ${d.other_income_period}` : ""}
              {d.other_income_pct >= 10 ? " · red-flag band" : ""}
            </div>
          </div>
        ) : null}

        {promNote ? (
          <div className="napkin-extras-card">
            <div className="napkin-extras-label">Promoter</div>
            <div
              className={`napkin-extras-value ${
                d.promoter_delta_pp != null && d.promoter_delta_pp <= -2 ? "is-warn" : ""
              }`}
            >
              {promNote}
            </div>
            <div className="napkin-extras-meta">
              {promNewest?.period ?? ""}
              {d.promoter.length > 1 ? ` · ${d.promoter.length} qtrs` : ""}
            </div>
          </div>
        ) : null}

        {d.ocf.length ? (
          <div className="napkin-extras-card">
            <div className="napkin-extras-label">Operating cash</div>
            <div className="napkin-extras-value">
              {fmtCr(d.ocf[0]!.value)}
              {d.ocf_trend ? (
                <span className={`napkin-extras-trend is-${d.ocf_trend}`}> {d.ocf_trend}</span>
              ) : null}
            </div>
            <div className="napkin-extras-meta">
              {d.ocf
                .slice(0, 3)
                .map((r) => `${r.period.replace(/^Mar /, "FY")}: ${fmtCr(r.value)}`)
                .join(" · ")}
            </div>
          </div>
        ) : null}

        {d.analyst ? (
          <div className="napkin-extras-card napkin-extras-card--analyst">
            <div className="napkin-extras-label">Street</div>
            <div className="napkin-extras-value">{d.analyst.consensus}</div>
            <div className="napkin-extras-bar" aria-hidden>
              <span className="is-buy" style={{ flex: Math.max(d.analyst.buy, 0.01) }} />
              <span className="is-hold" style={{ flex: Math.max(d.analyst.hold, 0.01) }} />
              <span className="is-sell" style={{ flex: Math.max(d.analyst.sell, 0.01) }} />
            </div>
            <div className="napkin-extras-meta">
              {d.analyst.buy} buy · {d.analyst.hold} hold · {d.analyst.sell} sell · n={d.analyst.total}
            </div>
          </div>
        ) : null}
      </div>

      {d.corp_actions.length ? (
        <div className="napkin-extras-actions">
          <button
            type="button"
            className="napkin-extras-toggle"
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen((v) => !v)}
          >
            <span>
              Corporate actions
              <em>
                {latestAction
                  ? ` · latest ${latestAction.name}${latestAction.expiry_date ? ` · ${latestAction.expiry_date}` : ""}`
                  : ""}
              </em>
            </span>
            <span className="napkin-extras-toggle-hint">
              {actionsOpen ? "Close" : `Open · ${d.corp_actions.length}`}
            </span>
          </button>
          {actionsOpen ? (
            <ul className="napkin-extras-action-list">
              {d.corp_actions.map((a, i) => (
                <li key={`${a.name}-${a.expiry_date}-${i}`}>
                  <strong>{a.name}</strong>
                  <span>{actionLine(a)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
