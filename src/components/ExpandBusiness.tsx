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
  return out.slice(0, 4);
}

function buildWatchLine(brief: CompanyBrief): string | null {
  const parts: string[] = [];
  if (brief.qtr_signal === "Declining" && brief.qtr_reason) {
    parts.push(brief.qtr_reason.split(";")[0]?.trim() || brief.qtr_reason);
  }
  if (isDisclosed(brief.watch || "")) parts.push(brief.watch.trim());
  return parts.length ? [...new Set(parts)].slice(0, 2).join(" · ") : null;
}

function disclosedCapex(brief: CompanyBrief): string | null {
  const c = brief.capex?.trim();
  if (!c || /unclear from sources|not disclosed|unavailable/i.test(c)) {
    return null;
  }
  return c;
}

function capabilityLine(brief: CompanyBrief): string {
  if (isDisclosed(brief.capabilities || "")) return brief.capabilities.trim();
  if (isDisclosed(brief.niche || "")) return brief.niche.trim();
  return brief.headline?.trim() || "";
}

/** Parse "Key: value" lines from cleaned screen_note / scrape. */
function parseCleanFields(
  raw: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const text = (raw ?? "").trim();
  if (!text) return out;
  for (const line of text.split(/\n+/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9 /&'_-]{1,48}):\s*(.+)$/);
    if (!m) continue;
    const key = m[1]!.trim().toLowerCase();
    const val = m[2]!.trim();
    if (!val || val === "—" || /^[—\-–]+$/.test(val) || /^n\/?a$/i.test(val)) {
      continue;
    }
    out[key] = val;
  }
  return out;
}

function field(fields: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = fields[k]?.trim();
    if (v) return v;
  }
  return "";
}

function extractGovSchemes(
  clean: string | null | undefined,
  fields: Record<string, string>,
): string[] {
  const blobs = [
    fields["differentiator"] || "",
    fields["customers"] || "",
    fields["track record"] || "",
    fields["infra"] || "",
    clean || "",
  ].join("\n");
  const found: string[] = [];
  const push = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t.length < 4 || t.length > 120) return;
    const key = t.toLowerCase();
    if (found.some((x) => x.toLowerCase() === key)) return;
    found.push(t);
  };

  const named =
    blobs.match(
      /\b(?:MeitY'?s?\s+)?PLI(?:\s+[Ss]cheme)?(?:\s+for\s+[A-Za-z0-9 &/-]{2,40})?|\bPMEGP\b|\bTUFS\b|\bMITRA\b|\bMake\s+in\s+India\b|\bAtmanirbhar(?:\s+Bharat)?\b|\b[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,3}\s+(?:Scheme|Yojana)\b/gi,
    ) ?? [];
  for (const n of named) push(n);

  for (const line of blobs.split(/\n+/)) {
    if (
      /gov(?:ernment)?\s+scheme|publicly funded|selected under|pli scheme|incentive/i.test(
        line,
      )
    ) {
      const clipped = line
        .replace(/^[^:]+:\s*/i, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140);
      if (clipped) push(clipped);
    }
  }
  return found.slice(0, 5);
}

function splitCsvish(raw: string | null | undefined): string[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  return t
    .split(/\s*[;|]\s*|\s*,\s+(?=[A-Z0-9])/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && p !== "—")
    .slice(0, 6);
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="biz-row">
      <span className="biz-row-label">{label}</span>
      <div className="biz-row-body">{children}</div>
    </div>
  );
}

export function ExpandBusiness({ data }: Props) {
  const { brief, context, loading, error, setupHint, waitingForQuarters } = data;

  const cleanRaw = context?.scraped_about_clean ?? null;
  const fields = parseCleanFields(cleanRaw);
  const groupName =
    context?.group_name?.trim() ||
    field(fields, "parent / group", "group", "group name") ||
    "";
  const recentMoves =
    context?.recent_moves?.trim() ||
    field(fields, "corporate events", "events", "recent moves") ||
    "";
  const businessModel =
    context?.business_model?.trim() ||
    field(fields, "business model", "model") ||
    "";
  const productsRaw = context?.products?.trim() || "";
  const endMarkets = context?.end_markets?.trim() || "";
  const customers =
    (brief?.customers || "").trim() || field(fields, "customers") || "";
  const differentiator = field(fields, "differentiator", "edge");
  const cleanSector = field(fields, "sector", "industry");
  const schemes = extractGovSchemes(cleanRaw, {
    ...fields,
    differentiator,
  });

  const hasClean = !!(
    groupName ||
    recentMoves ||
    businessModel ||
    productsRaw ||
    endMarkets ||
    customers ||
    schemes.length ||
    differentiator ||
    cleanSector
  );

  if (loading && !brief && !context) {
    return (
      <div className="biz-panel biz-compact">
        <p className="biz-loading-label">
          {waitingForQuarters ? "Reading QTR…" : "Building brief…"}
        </p>
      </div>
    );
  }

  if (!brief && !hasClean) {
    if (error) {
      return (
        <div className="biz-panel biz-compact">
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
    if (loading) {
      return (
        <div className="biz-panel biz-compact">
          <p className="biz-loading-label">
            {waitingForQuarters ? "Reading QTR…" : "Building brief…"}
          </p>
        </div>
      );
    }
    return null;
  }

  const headline = brief
    ? brief.headline?.trim() || capabilityLine(brief) || businessModel
    : businessModel || differentiator.slice(0, 120) || "";

  const model =
    businessModel ||
    (brief ? capabilityLine(brief) : "") ||
    differentiator ||
    "";

  const triggers = brief ? buildGrowthTriggers(brief) : [];
  const capex = brief ? disclosedCapex(brief) : null;
  const watch = brief ? buildWatchLine(brief) : null;

  const briefOfferings: OfferingItem[] = brief
    ? brief.offerings?.length > 0
      ? brief.offerings.slice(0, 4)
      : (brief.products ?? []).slice(0, 4).map((name) => ({ name, line: "" }))
    : [];
  const productItems = briefOfferings.length
    ? briefOfferings
    : splitCsvish(productsRaw).map((name) => ({ name, line: "" }));

  const sector = brief?.sector?.trim() || context?.sector?.trim() || "";
  const subSector =
    brief?.sub_sector?.trim() || context?.sub_sector?.trim() || "";
  const themeTags = (() => {
    const fromBrief = (brief?.themes ?? []).map((t) => t.trim()).filter(Boolean);
    const fromCtx = (context?.themes ?? [])
      .map((t) => t.tag.trim())
      .filter(Boolean);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of [...fromBrief, ...fromCtx]) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    if (cleanSector) {
      const key = cleanSector.toLowerCase();
      const overlapsListing =
        key === sector.toLowerCase() || key === subSector.toLowerCase();
      if (!overlapsListing && !seen.has(key) && cleanSector.length <= 48) {
        out.push(cleanSector);
      }
    }
    return out.slice(0, 6);
  })();

  const meta = [sector, subSector, ...themeTags].filter(Boolean);
  const marketsLine = [endMarkets, customers]
    .filter(Boolean)
    .filter((v, i, a) => a.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i)
    .join(" · ");

  return (
    <div className="biz-panel biz-compact">
      {loading && !brief ? (
        <p className="biz-loading-label">Building brief…</p>
      ) : null}

      {headline ? <p className="biz-lead">{headline}</p> : null}
      {meta.length ? <p className="biz-meta">{meta.join(" · ")}</p> : null}

      {model ? <Row label="Model">{model}</Row> : null}

      {productItems.length ? (
        <Row label="Sells">
          <ul className="biz-inline-list">
            {productItems.map((o) => (
              <li key={o.name}>
                <strong>{o.name}</strong>
                {o.line ? ` — ${o.line}` : null}
              </li>
            ))}
          </ul>
        </Row>
      ) : null}

      {marketsLine ? <Row label="Markets">{marketsLine}</Row> : null}

      {schemes.length ? (
        <Row label="Schemes">
          <ul className="biz-theme-chips biz-theme-chips--scheme">
            {schemes.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Row>
      ) : null}

      {triggers.length ? (
        <Row label="Triggers">{triggers.join(", ")}</Row>
      ) : null}

      {capex ? <Row label="Capex">{capex}</Row> : null}

      {groupName ? <Row label="Group">{groupName}</Row> : null}

      {recentMoves ? <Row label="Events">{recentMoves}</Row> : null}

      {brief?.qtr_signal ? (
        <Row label="Qtr">
          <span
            className={`biz-qtr-verdict biz-qtr-verdict--${verdictClass(brief.qtr_signal)}`}
          >
            {brief.qtr_signal}
          </span>
          {brief.qtr_reason ? (
            <span className="biz-qtr-reason">{brief.qtr_reason}</span>
          ) : null}
        </Row>
      ) : null}

      {watch ? <Row label="Watch">{watch}</Row> : null}

      {error && !brief ? (
        <p className="biz-note-meta">Brief unavailable: {error}</p>
      ) : null}
    </div>
  );
}
