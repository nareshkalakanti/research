"use client";

import type { ConcallDriftContext, MarketBias } from "@/lib/concall-drift-review";
import type { DisclosureLadderItem } from "@/lib/disclosure-ladder";
import type { ExpandConcallDriftData } from "@/lib/use-expand-concall-drift";

type Props = {
  data: ExpandConcallDriftData;
  drift: ConcallDriftContext;
  price: number | null;
};

function fmtDrift(pct: number | null): string {
  if (pct == null) return "—";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function fmtEventDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function biasArrow(bias: MarketBias): string {
  if (bias === "long") return "▲";
  if (bias === "short") return "▼";
  return "●";
}

function tagClass(tag: DisclosureLadderItem["tag"]): string {
  if (tag === "EARNINGS") return "ladder-tag ladder-tag--earn";
  if (tag === "BUYBACK") return "ladder-tag ladder-tag--buyback";
  if (tag === "IR") return "ladder-tag ladder-tag--ir";
  return "ladder-tag ladder-tag--update";
}

export function ExpandConcallDrift({ data, drift, price }: Props) {
  const { review, loading, error, setupHint } = data;

  if (loading && !review) {
    return (
      <div className="concall-panel">
        <p className="concall-loading">Reading filings, concall &amp; price path…</p>
      </div>
    );
  }

  if (error && !review) {
    return (
      <div className="concall-panel">
        <p className="concall-error">{error}</p>
        {setupHint ? (
          <p className="concall-meta">
            <code>{setupHint}</code>
          </p>
        ) : null}
        <p className="concall-meta">
          Download concall / PPT on the <strong>Calls</strong> tab, then reopen{" "}
          <strong>Concall</strong>.
        </p>
      </div>
    );
  }

  if (!review) return null;

  const anchor = drift.concall_at || drift.earn_at;
  const up = (drift.drift_pct ?? 0) >= 0;
  const ladder = review.disclosure_ladder;
  const summaries = review.filing_summaries;

  return (
    <div className="concall-panel concall-stack">
      <section className={`concall-bias concall-bias--${review.bias}`}>
        <div className="concall-bias-head">
          <span className="concall-bias-arrow" aria-hidden>
            {biasArrow(review.bias)}
          </span>
          <strong className="concall-bias-label">{review.bias_label}</strong>
          <span className="concall-bias-summary">{review.bias_summary}</span>
        </div>
        {review.bias_callout ? (
          <p className="concall-bias-callout">⚠ {review.bias_callout}</p>
        ) : null}
      </section>

      {ladder.length ? (
        <section className="concall-section">
          <h4 className="concall-section-title">
            Disclosure ladder — click any report to verify on NSE
          </h4>
          <ul className="disclosure-ladder">
            {ladder.map((item) => (
              <li key={`${item.announced_at}-${item.title}`} className="disclosure-ladder-row">
                <span className="disclosure-ladder-time">{item.time_label}</span>
                <span className={tagClass(item.tag)}>{item.tag}</span>
                <span className="disclosure-ladder-title">{item.title}</span>
                <span className="disclosure-ladder-badges">
                  {item.is_trigger ? (
                    <span className="ladder-badge ladder-badge--trigger">Trigger</span>
                  ) : null}
                  {item.badge && item.badge !== "TRIGGER" ? (
                    <span className="ladder-badge ladder-badge--press">{item.badge}</span>
                  ) : null}
                </span>
                {item.url ? (
                  <a
                    className="disclosure-ladder-report"
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Report ↗
                  </a>
                ) : (
                  <span className="disclosure-ladder-report disclosure-ladder-report--muted">
                    —
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="concall-section">
        <h4 className="concall-section-title">AI summary — what each filing actually says</h4>
        {review.pinned_summary ? (
          <p className="concall-pinned">📌 {review.pinned_summary}</p>
        ) : null}
        {summaries.length ? (
          <ul className="concall-filing-summaries">
            {summaries.map((row) => (
              <li key={`${row.time}-${row.summary.slice(0, 24)}`}>
                <span className="concall-filing-time">{row.time}</span>
                <span className="concall-filing-text">{row.summary}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="concall-meta">
            {review.has_transcript
              ? "No per-filing breakdown returned — see headline below."
              : "No extractable text from filings — import concall/PPT on Calls tab."}
          </p>
        )}
      </section>

      {review.daily_path.length ? (
        <section className="concall-section">
          <h4 className="concall-section-title">
            Price reaction · from {fmtEventDate(anchor)} · daily
          </h4>
          <div className="concall-drift-path-wrap">
            <table className="concall-drift-path-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">Close</th>
                  <th className="num">vs baseline</th>
                  <th className="num">vs prior</th>
                </tr>
              </thead>
              <tbody>
                {review.daily_path.map((p) => (
                  <tr key={p.date}>
                    <td>{p.date}</td>
                    <td className="num">{p.close.toLocaleString("en-IN")}</td>
                    <td
                      className={`num ${
                        (p.pct_from_baseline ?? 0) >= 0
                          ? "strategy-drift-up"
                          : "strategy-drift-down"
                      }`}
                    >
                      {fmtDrift(p.pct_from_baseline)}
                    </td>
                    <td className="num">{fmtDrift(p.pct_from_prior)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="concall-meta">
            Baseline ₹{drift.baseline_close?.toLocaleString("en-IN") ?? "—"} → CMP ₹
            {price?.toLocaleString("en-IN") ?? "—"} ·{" "}
            <span className={up ? "strategy-drift-up" : "strategy-drift-down"}>
              {fmtDrift(drift.drift_pct)}
            </span>
          </p>
        </section>
      ) : null}

      <section className="concall-section concall-section--compact">
        <h4 className="concall-section-title">Move read</h4>
        <p className="concall-headline">{review.headline}</p>
        <p className="concall-body">{review.move_summary}</p>
        <p className="concall-body">{review.reaction_summary}</p>
      </section>

      {review.triggers.length ? (
        <div className="concall-card">
          <p className="concall-card-label">{up ? "Upside triggers" : "Downside triggers"}</p>
          <ul className="concall-list">
            {review.triggers.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {review.concall_highlights.length ? (
        <div className="concall-card">
          <p className="concall-card-label">On the concall</p>
          <ul className="concall-list">
            {review.concall_highlights.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {review.risks.length ? (
        <div className="concall-card concall-card--watch">
          <p className="concall-card-label">Risks / gaps</p>
          <ul className="concall-list">
            {review.risks.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
