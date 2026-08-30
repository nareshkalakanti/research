"use client";

import type { CallReviewRow, CompanyBrief, GovSignal, QtrSignal } from "@/lib/company-brief";
import type { ExpandBriefData } from "@/lib/use-expand-brief";

type Props = {
  data: ExpandBriefData;
};

type VerdictSignal = QtrSignal | GovSignal;

function isDisclosed(text: string): boolean {
  const t = text.trim();
  if (!t || t.replace(/\s/g, "").length < 12) return false;
  return !/^not disclosed$/i.test(t);
}

function directionClass(direction: string): string {
  const d = direction.toLowerCase();
  if (d.startsWith("pos")) return "positive";
  if (d.startsWith("neg")) return "negative";
  return "neutral";
}

function verdictClass(signal: VerdictSignal): string {
  return signal.toLowerCase().replace(/\s+/g, "-");
}

function splitTriggers(text: string): string[] {
  return text
    .split(/\s*·\s*|\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function buildGrowthTriggers(brief: CompanyBrief): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (!isDisclosed(t)) return;
    const key = t.toLowerCase().slice(0, 48);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  for (const part of splitTriggers(brief.growth_triggers || "")) add(part);

  for (const row of brief.call_review_rows ?? []) {
    if (row.direction !== "positive" || out.length >= 5) continue;
    if (isDisclosed(row.thesis_impact)) add(row.thesis_impact);
    else if (isDisclosed(row.what_said)) {
      add(row.what_said.split("·")[0]?.trim() || row.what_said);
    }
  }

  return out.slice(0, 5);
}

function buildWatchLine(brief: CompanyBrief): string | null {
  const parts: string[] = [];
  if (brief.qtr_signal === "Declining" && brief.qtr_reason) {
    parts.push(brief.qtr_reason.split(";")[0]?.trim() || brief.qtr_reason);
  }
  for (const row of brief.call_review_rows ?? []) {
    if (row.direction === "negative" && isDisclosed(row.what_said)) {
      parts.push(row.what_said.split("·")[0]?.trim() || row.what_said);
    }
  }
  if (isDisclosed(brief.watch || "")) parts.push(brief.watch.trim());
  return parts.length ? [...new Set(parts)].slice(0, 2).join(" · ") : null;
}

function disclosedCapex(brief: CompanyBrief): string {
  const c = brief.capex?.trim();
  if (!c || /unclear from sources/i.test(c)) {
    return "No explicit capex guidance in latest sources";
  }
  if (/not disclosed|unavailable/i.test(c)) {
    return "No explicit capex guidance in latest sources";
  }
  return c;
}

function capabilityLine(brief: CompanyBrief): string {
  if (isDisclosed(brief.capabilities || "")) return brief.capabilities.trim();
  if (isDisclosed(brief.niche || "")) return brief.niche.trim();
  return brief.headline?.trim() || "Capability unclear from sources";
}

function disclosedCallRows(rows: CallReviewRow[] | undefined): CallReviewRow[] {
  return (rows ?? []).filter((r) => isDisclosed(r.what_said));
}

function SimpleCallSignals({ rows }: { rows: CallReviewRow[] }) {
  return (
    <ul className="biz-signal-list">
      {rows.map((row) => (
        <li key={row.category} className={`biz-signal biz-signal--${directionClass(row.direction)}`}>
          <span className="biz-signal-cat">{row.category}</span>
          <span className="biz-signal-text">{row.what_said}</span>
        </li>
      ))}
    </ul>
  );
}

export function ExpandBusiness({ data }: Props) {
  const { brief, context, loading, error, setupHint, waitingForQuarters } = data;

  if (loading) {
    return (
      <div className="biz-panel">
        <p className="biz-loading-label">
          {waitingForQuarters ? "Reading QTR data…" : "Building business view…"}
        </p>
      </div>
    );
  }

  if (error && !brief) {
    return (
      <div className="biz-panel">
        <p className="biz-note-text">{error}</p>
        {setupHint ? (
          <p className="biz-note-meta">
            {setupHint.split(" · ").map((step) => (
              <span key={step}>
                <code>{step}</code>
              </span>
            ))}
          </p>
        ) : null}
      </div>
    );
  }

  if (!brief) return null;

  const companyName = context?.name || brief.headline || "Company";
  const ticker = context?.ticker || "";
  const triggers = buildGrowthTriggers(brief);
  const capex = disclosedCapex(brief);
  const watch = buildWatchLine(brief);
  const callRows = disclosedCallRows(brief.call_review_rows);
  const callHeadline = brief.call_review_headline?.trim();
  const products = brief.products?.slice(0, 5) ?? [];

  const hasDetails =
    callRows.length > 0 ||
    brief.model ||
    brief.customers ||
    brief.qtr_reason ||
    brief.gov_reason;

  return (
    <div className="biz-panel biz-stack">
      <section className="biz-hero">
        <span className="biz-hero-kicker">Capabilities, growth triggers &amp; capex</span>
        <h3 className="biz-hero-title">{companyName}</h3>
        {ticker ? <div className="biz-hero-ticker">{ticker}</div> : null}
        {callHeadline && callHeadline.toLowerCase() !== companyName.toLowerCase() ? (
          <p className="biz-hero-lead">{callHeadline}</p>
        ) : null}
        {brief.call_review_sources ? (
          <p className="biz-hero-meta">Calls · {brief.call_review_sources}</p>
        ) : null}
      </section>

      <div className="biz-highlight biz-highlight--teal">
        <span className="biz-highlight-label">Capability</span>
        <p>{capabilityLine(brief)}</p>
      </div>

      {triggers.length ? (
        <div className="biz-card">
          <p className="biz-card-label">Growth triggers</p>
          <ul className="biz-trigger-list">
            {triggers.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="biz-highlight biz-highlight--amber">
        <span className="biz-highlight-label">Capex</span>
        <p>{capex}</p>
      </div>

      <div className="biz-duo">
        {brief.qtr_signal ? (
          <div className="biz-card biz-duo-card">
            <div className="biz-note-head">
              <p className="biz-card-label">Quarters</p>
              <span
                className={`biz-qtr-verdict biz-qtr-verdict--${verdictClass(brief.qtr_signal)}`}
              >
                {brief.qtr_signal}
              </span>
            </div>
            <p className="biz-card-text">{brief.qtr_reason || "—"}</p>
          </div>
        ) : null}
        {watch ? (
          <div className="biz-card biz-duo-card biz-card--watch">
            <p className="biz-card-label">Watch</p>
            <p className="biz-card-text">{watch}</p>
          </div>
        ) : brief.model ? (
          <div className="biz-card biz-duo-card">
            <p className="biz-card-label">Model</p>
            <p className="biz-card-text">{brief.model}</p>
          </div>
        ) : null}
      </div>

      {products.length ? (
        <div className="biz-card">
          <p className="biz-card-label">Offerings</p>
          <ul className="biz-chip-list">
            {products.map((p) => (
              <li key={p}>
                <span className="biz-chip">{p}</span>
              </li>
            ))}
          </ul>
          {brief.customers ? <p className="biz-card-meta">Customers · {brief.customers}</p> : null}
        </div>
      ) : null}

      {hasDetails ? (
        <details className="biz-details">
          <summary className="biz-details-summary">Call review &amp; notes</summary>
          <div className="biz-details-body">
            {callRows.length ? <SimpleCallSignals rows={callRows} /> : null}
            <dl className="biz-details-dl">
              {brief.customers && !products.length ? (
                <>
                  <dt>Customers</dt>
                  <dd>{brief.customers}</dd>
                </>
              ) : null}
              {brief.gov_reason ? (
                <>
                  <dt>Governance</dt>
                  <dd>
                    {brief.gov_signal ? `${brief.gov_signal} — ` : ""}
                    {brief.gov_reason}
                  </dd>
                </>
              ) : null}
            </dl>
          </div>
        </details>
      ) : null}
    </div>
  );
}
