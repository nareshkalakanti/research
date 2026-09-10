/**
 * Client-safe quant formatters (no fs / sqlite / LLM).
 * Use \u20B9 escapes — SWC rejects bare ₹ in some regex/identifier contexts.
 */

const INR = "\u20B9";

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function num(
  o: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** First qN_fyNN_<INR>cr value (highest FY wins when multiple). */
function firstPeriodCr(o: Record<string, unknown>): number | null {
  const re = new RegExp(`^q[1-4]_fy\\d{2}_${INR}cr$`, "i");
  const keys = Object.keys(o).filter((k) => re.test(k)).sort().reverse();
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function firstPeriodMargin(o: Record<string, unknown>): number | null {
  const keys = Object.keys(o)
    .filter((k) => /^q[1-4]_fy\d{2}_margin_%$/i.test(k))
    .sort()
    .reverse();
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Human-readable executive summary for the Summary viewer. */
export function formatExecutiveSummaryText(
  json: Record<string, unknown> | null | undefined,
): string {
  if (!json) return "";
  const meta = asObj(json.metadata) || {};
  const inv = asObj(json.investment_summary) || {};
  const fin = asObj(json.financial_snapshot) || {};
  const rev = asObj(fin.revenue) || {};
  const ebitda = asObj(fin.ebitda) || {};
  const pat = asObj(fin.pat) || {};
  const ob = asObj(fin.order_book) || {};
  const near = Array.isArray(json.near_term_catalysts_6m)
    ? json.near_term_catalysts_6m.filter((x) => typeof x === "string")
    : [];
  const mid = Array.isArray(json.medium_term_catalysts_12m)
    ? json.medium_term_catalysts_12m.filter((x) => typeof x === "string")
    : [];

  const revCr =
    num(rev, `current_${INR}cr`) ??
    firstPeriodCr(rev) ??
    num(rev, `q1_fy27_${INR}cr`);
  const revYoy = num(rev, "yoy_growth_%");
  const ebitdaMargin =
    num(ebitda, "current_margin_%") ?? firstPeriodMargin(ebitda);
  const ebitdaBps = num(ebitda, "margin_change_bps");
  const patCr = num(pat, `current_${INR}cr`) ?? firstPeriodCr(pat);
  const pending = num(ob, `pending_${INR}cr`, `pending_ob_${INR}cr`);
  const inflow = num(
    ob,
    `period_inflow_${INR}cr`,
    `q1_inflow_${INR}cr`,
    `q1_order_inflow_${INR}cr`,
  );

  const lines: string[] = [];
  lines.push(
    [meta.company || "Company", meta.reporting_period, meta.event_date]
      .filter(Boolean)
      .join(" · "),
  );
  lines.push("");
  if (revCr != null || revYoy != null) {
    lines.push(
      `Revenue: ${revCr != null ? `${INR}${revCr} Cr` : "—"}${
        revYoy != null ? ` (${revYoy}% YoY)` : ""
      }`,
    );
  }
  if (ebitdaMargin != null || ebitdaBps != null) {
    lines.push(
      `EBITDA margin: ${ebitdaMargin != null ? `${ebitdaMargin}%` : "—"}${
        ebitdaBps != null ? ` (${ebitdaBps} bps)` : ""
      }`,
    );
  }
  if (patCr != null) {
    lines.push(`PAT: ${INR}${patCr} Cr`);
  }
  if (pending != null || inflow != null) {
    lines.push(
      `Order book: ${pending != null ? `${INR}${pending} Cr pending` : "—"}${
        inflow != null ? ` · inflow ${INR}${inflow} Cr` : ""
      }`,
    );
  }
  lines.push("");
  if (typeof inv.bull_case === "string" && inv.bull_case.trim()) {
    lines.push("BULL");
    lines.push(inv.bull_case.trim());
    lines.push("");
  }
  if (typeof inv.bear_case === "string" && inv.bear_case.trim()) {
    lines.push("BEAR");
    lines.push(inv.bear_case.trim());
    lines.push("");
  }
  if (typeof inv.valuation_anchors === "string" && inv.valuation_anchors.trim()) {
    const a = inv.valuation_anchors.trim();
    if (
      a.length >= 24 &&
      !/private\s*(?:&|and)\s*confidential|safe\s*harbour/i.test(a) &&
      /(\d|₹|cr|%|coverage|ROCE|ROE)/i.test(a)
    ) {
      lines.push("ANCHORS");
      lines.push(a);
      lines.push("");
    }
  }
  if (near.length) {
    lines.push("NEAR-TERM (6M)");
    for (const n of near.slice(0, 6)) lines.push(`• ${n}`);
    lines.push("");
  }
  if (mid.length) {
    lines.push("MEDIUM-TERM (12M)");
    for (const n of mid.slice(0, 6)) lines.push(`• ${n}`);
  }
  return lines.join("\n").trim();
}
