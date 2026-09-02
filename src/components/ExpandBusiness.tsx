"use client";

import type { CompanyBrief, OfferingItem, QtrSignal } from "@/lib/company-brief";
import type { ExpandBriefData } from "@/lib/use-expand-brief";

type Props = {
  data: ExpandBriefData;
};

function isDisclosed(text: string): boolean {
  const t = text.trim();
  if (!t || t.replace(/\s/g, "").length < 12) return false;
  return !/^not disclosed$/i.test(t);
}

function verdictClass(signal: QtrSignal): string {
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
  for (const part of splitTriggers(brief.growth_triggers || "")) {
    const t = part.trim();
    if (!isDisclosed(t)) continue;
    const key = t.toLowerCase().slice(0, 48);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.slice(0, 5);
}

function buildWatchLine(brief: CompanyBrief): string | null {
  const parts: string[] = [];
  if (brief.qtr_signal === "Declining" && brief.qtr_reason) {
    parts.push(brief.qtr_reason.split(";")[0]?.trim() || brief.qtr_reason);
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

export function ExpandBusiness({ data }: Props) {
  const { brief, context, loading, error, setupHint, waitingForQuarters } = data;

  if (loading && !brief) {
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

  const triggers = buildGrowthTriggers(brief);
  const capex = disclosedCapex(brief);
  const watch = buildWatchLine(brief);
  const offerings: OfferingItem[] =
    brief.offerings?.length > 0
      ? brief.offerings.slice(0, 5)
      : (brief.products ?? []).slice(0, 5).map((name) => ({ name, line: "" }));
  const sector = brief.sector?.trim() || context?.sector?.trim() || "";
  const subSector = brief.sub_sector?.trim() || context?.sub_sector?.trim() || "";
  const themeTags = brief.themes?.length
    ? brief.themes
    : (context?.themes ?? []).map((t) => t.tag);
  const themeTitles = new Map((context?.themes ?? []).map((t) => [t.tag, t.name]));
  const hasClassification = sector || subSector || themeTags.length > 0;

  return (
    <div className="biz-panel biz-stack">
      <section className="biz-hero">
        <span className="biz-hero-kicker">Capabilities, growth triggers &amp; capex</span>
        <h3 className="biz-hero-title">{brief.headline?.trim() || capabilityLine(brief)}</h3>
        {hasClassification ? (
          <dl className="biz-classify">
            {sector ? (
              <>
                <dt>Sector</dt>
                <dd>{sector}</dd>
              </>
            ) : null}
            {subSector && subSector.toLowerCase() !== sector.toLowerCase() ? (
              <>
                <dt>Sub-sector</dt>
                <dd>{subSector}</dd>
              </>
            ) : null}
            {themeTags.length ? (
              <>
                <dt>Theme</dt>
                <dd>
                  <ul className="biz-chip-list biz-chip-list--inline">
                    {themeTags.map((tag) => (
                      <li key={tag}>
                        <span className="biz-chip" title={themeTitles.get(tag) || tag}>
                          {tag}
                        </span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
          </dl>
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

      {offerings.length ? (
        <div className="biz-card biz-card--offerings">
          <p className="biz-card-label">Offerings</p>
          <dl className="biz-offering-list">
            {offerings.map((o) => (
              <div key={o.name} className="biz-offering-item">
                <dt className="biz-offering-name">{o.name}</dt>
                {o.line ? <dd className="biz-offering-line">{o.line}</dd> : null}
              </div>
            ))}
          </dl>
          {brief.customers ? (
            <div className="biz-offering-customers">
              <p className="biz-offering-customers-label">Customers</p>
              <p className="biz-offering-customers-text">{brief.customers}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
