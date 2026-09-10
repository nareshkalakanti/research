/**
 * Client-safe view-model for executive summary HTML (test/summary.html layout).
 * Driven entirely by quant JSON — no company hardcoding.
 */

const INR = "\u20B9";

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function num(
  o: Record<string, unknown> | null | undefined,
  ...keys: string[]
): number | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function str(
  o: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function firstPeriodMoney(o: Record<string, unknown> | null): number | null {
  if (!o) return null;
  const re = new RegExp(`^q[1-4]_fy\\d{2}_${INR}cr$`, "i");
  const keys = Object.keys(o)
    .filter((k) => re.test(k))
    .sort()
    .reverse();
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return num(o, `current_${INR}cr`);
}

function firstPeriodMargin(o: Record<string, unknown> | null): number | null {
  if (!o) return null;
  const keys = Object.keys(o)
    .filter(
      (k) =>
        /^q[1-4]_fy\d{2}_margin_%$/i.test(k) || k === "current_margin_%",
    )
    .sort()
    .reverse();
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export function fmtCr(n: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const s =
    abs >= 100
      ? n.toLocaleString("en-IN", { maximumFractionDigits: 0 })
      : n.toLocaleString("en-IN", {
          maximumFractionDigits: digits,
          minimumFractionDigits: 0,
        });
  return `${INR}${s}cr`;
}

export function fmtPct(n: number | null, signed = false): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${n}%`;
}

function humanizeKey(k: string): string {
  return k
    .replace(/_%$/g, "")
    .replace(new RegExp(`_${INR}cr$`, "g"), "")
    .replace(/_₹cr$/g, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export type ExecSummaryView = {
  company: string;
  period: string | null;
  eventDate: string | null;
  symbol: string | null;
  sentiment: string | null;
  score: number | null;
  revenue: {
    value: number | null;
    yoy: number | null;
    guideLow: number | null;
    guideHigh: number | null;
    guideGrowth: number | null;
  };
  ebitda: {
    value: number | null;
    yoy: number | null;
    margin: number | null;
    marginBps: number | null;
  };
  pat: {
    value: number | null;
    yoy: number | null;
    margin: number | null;
    marginBps: number | null;
  };
  orderBook: {
    pending: number | null;
    inflow: number | null;
    inflowYoy: number | null;
    visibility: string | null;
    largest: number | null;
    largestSector: string | null;
  };
  metricBoxes: Array<{ label: string; value: string; sub?: string }>;
  sectors: Array<{ label: string; pct: number }>;
  capexItems: Array<{ title: string; detail: string }>;
  peak: {
    low: number | null;
    high: number | null;
    timeline: string | null;
    cagrLow: number | null;
    cagrHigh: number | null;
    utilLow: number | null;
    utilHigh: number | null;
    netCash: number | null;
    rating: string | null;
  };
  risks: Array<{
    factor: string;
    impact: string;
    impactLevel: "high" | "medium" | "low";
    timeline: string;
    mitigation: string;
  }>;
  nearCatalysts: string[];
  midCatalysts: string[];
  bull: string | null;
  bear: string | null;
  anchors: string | null;
  hasFinancials: boolean;
};

function pctEntries(
  o: Record<string, unknown> | null,
): Array<{ label: string; pct: number }> {
  if (!o) return [];
  return Object.entries(o)
    .map(([k, v]) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      if (!/_%$/.test(k)) return null;
      return { label: humanizeKey(k), pct: v };
    })
    .filter(Boolean)
    .sort((a, b) => b!.pct - a!.pct) as Array<{ label: string; pct: number }>;
}

function flattenStringPairs(
  o: Record<string, unknown> | null,
  moneyHint = false,
): Array<{ title: string; detail: string }> {
  if (!o) return [];
  const items: Array<{ title: string; detail: string }> = [];
  for (const [k, v] of Object.entries(o)) {
    if (v == null) continue;
    if (typeof v === "object" && !Array.isArray(v)) continue;
    const title = humanizeKey(k);
    if (typeof v === "number") {
      const detail =
        moneyHint || /cr$/i.test(k) ? fmtCr(v) : String(v);
      items.push({ title, detail });
    } else if (typeof v === "string" && v.trim()) {
      items.push({ title, detail: v.trim() });
    }
  }
  return items;
}

function risksFromJson(
  risk: Record<string, unknown> | null,
): ExecSummaryView["risks"] {
  if (!risk) return [];
  const out: ExecSummaryView["risks"] = [];
  for (const [section, raw] of Object.entries(risk)) {
    const block = asObj(raw);
    if (!block) continue;
    const factor = humanizeKey(section);
    const bps = num(
      block,
      "q1_actual_impact_bps",
      "steel_price_sensitivity_bps",
    );
    const impact =
      str(
        block,
        "win_rate_concern",
        "execution_risk",
        "export_traction_status",
      ) || (bps != null ? `${bps}bps` : "—");
    const timeline =
      str(block, "expected_normalization", "affected_quarters") || "—";
    const mitigation =
      str(block, "mitigation_strategy", "management_confidence_level") ||
      Object.entries(block)
        .filter(([, v]) => typeof v === "string")
        .map(([, v]) => String(v))
        .slice(0, 2)
        .join(" · ") ||
      "—";
    const blob = `${impact} ${section}`;
    const impactLevel: "high" | "medium" | "low" = /low|nascent|0\./i.test(
      blob,
    )
      ? "low"
      : /high|spike|100bps/i.test(blob)
        ? "medium"
        : "medium";
    out.push({
      factor,
      impact: String(impact),
      impactLevel,
      timeline,
      mitigation,
    });
  }
  return out.slice(0, 8);
}

/** Build view model from quant.executive_summary (+ optional card sentiment). */
export function buildExecSummaryView(
  exec: Record<string, unknown> | null | undefined,
  opts?: {
    sentiment?: string | null;
    score?: number | null;
    nseSymbol?: string | null;
  },
): ExecSummaryView | null {
  if (!exec || typeof exec !== "object") return null;
  const meta = asObj(exec.metadata) || {};
  const fin = asObj(exec.financial_snapshot) || {};
  const rev = asObj(fin.revenue);
  const ebitda = asObj(fin.ebitda);
  const pat = asObj(fin.pat);
  const ob = asObj(fin.order_book);
  const ops = asObj(exec.operational_metrics);
  const capUtil = asObj(ops?.capacity_utilization);
  const execOps = asObj(ops?.execution);
  const seg = asObj(exec.segment_analysis);
  const sectorObj =
    asObj(seg?.order_book_by_sector_q1) ||
    asObj(seg?.order_book_by_sector) ||
    Object.values(seg || {})
      .map((v) => asObj(v))
      .find((o) => o && Object.keys(o).some((k) => /_%$/.test(k))) ||
    null;
  const capexRoot = asObj(exec.capex_and_returns);
  const capexAlloc = asObj(capexRoot?.capex_allocation);
  const peak = asObj(capexRoot?.peak_revenue_potential);
  const cash = asObj(capexRoot?.cash_and_debt);
  const inv = asObj(exec.investment_summary) || {};
  const risk = asObj(exec.risk_factors);

  const revenueVal = firstPeriodMoney(rev);
  const ebitdaVal = firstPeriodMoney(ebitda);
  const patVal = firstPeriodMoney(pat);
  const pending =
    num(ob, `pending_${INR}cr`, `pending_ob_${INR}cr`) ??
    firstPeriodMoney(ob);

  const metricBoxes: ExecSummaryView["metricBoxes"] = [];
  const pebUtil = num(capUtil, "peb_utilization_q1_%", "peb_utilization_%");
  const pebTarget = num(capUtil, "peb_utilization_target_%");
  if (pebUtil != null) {
    metricBoxes.push({
      label: "PEB Capacity Utilization",
      value: fmtPct(pebUtil),
      sub: pebTarget != null ? `Target: ${fmtPct(pebTarget)}` : undefined,
    });
  }
  const panelUtil = num(
    capUtil,
    "sandwich_panel_q1_utilization_%",
    "panel_utilization_%",
  );
  if (panelUtil != null) {
    const target = num(capUtil, "sandwich_panel_fy27_target_%");
    metricBoxes.push({
      label: "Panel Utilization",
      value: fmtPct(panelUtil),
      sub: target != null ? `Target: ${fmtPct(target)}` : undefined,
    });
  }
  const win = num(execOps, "win_rate_%");
  if (win != null) {
    const bench = num(execOps, "industry_benchmark_win_rate_%");
    metricBoxes.push({
      label: "Win Rate",
      value: fmtPct(win),
      sub: bench != null ? `vs ${fmtPct(bench)} industry` : undefined,
    });
  }
  const avgOrder = num(execOps, `avg_order_size_q1_${INR}cr`);
  if (avgOrder != null) {
    const prior = num(execOps, `avg_order_size_fy26_${INR}cr`);
    const growth = num(execOps, "order_size_growth_%");
    metricBoxes.push({
      label: "Avg Order Size",
      value: fmtCr(avgOrder),
      sub:
        growth != null
          ? `${fmtPct(growth, true)}${prior != null ? ` from ${fmtCr(prior)}` : ""}`
          : undefined,
    });
  }
  if (metricBoxes.length < 2 && capUtil) {
    for (const [k, v] of Object.entries(capUtil)) {
      if (metricBoxes.length >= 4) break;
      if (typeof v !== "number") continue;
      if (!/util|%|capacity/i.test(k)) continue;
      metricBoxes.push({ label: humanizeKey(k), value: String(v) });
    }
  }

  const capexItems: ExecSummaryView["capexItems"] = [];
  if (capexAlloc) {
    const moneyKeys = Object.keys(capexAlloc).filter(
      (k) =>
        typeof capexAlloc[k] === "number" &&
        new RegExp(`${INR}cr|_cr$`, "i").test(k),
    );
    for (const mk of moneyKeys.slice(0, 6)) {
      const prefix = mk
        .replace(new RegExp(`_${INR}cr$`, "i"), "")
        .replace(/_cr$/i, "");
      const status =
        str(
          capexAlloc,
          `${prefix}_status`,
          `${prefix}_timeline`,
          `${prefix}_commissioning`,
          `${prefix}_commissioning_timeline`,
          `${prefix}_production_start`,
          `${prefix}_line1_status`,
          `${prefix}_line2_timeline`,
        ) || "";
      const amt = num(capexAlloc, mk);
      capexItems.push({
        title: humanizeKey(prefix),
        detail: [amt != null ? fmtCr(amt) : null, status]
          .filter(Boolean)
          .join(" | "),
      });
    }
    if (!capexItems.length) {
      capexItems.push(...flattenStringPairs(capexAlloc, true).slice(0, 6));
    }
  }

  const near = Array.isArray(exec.near_term_catalysts_6m)
    ? exec.near_term_catalysts_6m.filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  const mid = Array.isArray(exec.medium_term_catalysts_12m)
    ? exec.medium_term_catalysts_12m.filter(
        (x): x is string => typeof x === "string",
      )
    : [];

  const company = str(meta, "company") || "Company";
  const hasFinancials =
    revenueVal != null ||
    ebitdaVal != null ||
    patVal != null ||
    pending != null;

  const scrubAnchor = (s: string | null): string | null => {
    if (!s || s.trim().length < 24) return null;
    if (
      /private\s*(?:&|and)\s*confidential|safe\s*harbour|forward[- ]looking|for\s+information\s+purposes/i.test(
        s,
      )
    ) {
      return null;
    }
    if (!/(\d|₹|cr|%|x\b|coverage|ROCE|ROE|P\/E|EV)/i.test(s)) return null;
    return s.trim();
  };

  return {
    company,
    period: str(meta, "reporting_period"),
    eventDate: str(meta, "event_date"),
    symbol: opts?.nseSymbol || str(meta, "nse_symbol"),
    sentiment: opts?.sentiment || null,
    score: opts?.score ?? null,
    revenue: {
      value: revenueVal,
      yoy: num(rev, "yoy_growth_%"),
      guideLow: num(
        rev,
        `fy27_guidance_${INR}cr_low`,
        `guidance_${INR}cr_low`,
      ),
      guideHigh: num(
        rev,
        `fy27_guidance_${INR}cr_high`,
        `guidance_${INR}cr_high`,
      ),
      guideGrowth: num(rev, "fy27_guidance_growth_%", "guidance_growth_%"),
    },
    ebitda: {
      value: ebitdaVal,
      yoy: num(ebitda, "yoy_growth_%"),
      margin: firstPeriodMargin(ebitda),
      marginBps: num(ebitda, "margin_change_bps"),
    },
    pat: {
      value: patVal,
      yoy: num(pat, "yoy_growth_%"),
      margin: firstPeriodMargin(pat),
      marginBps: num(pat, "margin_change_bps"),
    },
    orderBook: {
      pending,
      inflow: num(
        ob,
        `q1_inflow_${INR}cr`,
        `period_inflow_${INR}cr`,
        `q1_order_inflow_${INR}cr`,
      ),
      inflowYoy: num(ob, "q1_inflow_growth_%", "inflow_growth_%"),
      visibility: str(ob, "visibility_months"),
      largest: num(ob, `largest_order_${INR}cr`),
      largestSector: str(ob, "largest_order_sector"),
    },
    metricBoxes,
    sectors: pctEntries(sectorObj),
    capexItems,
    peak: {
      low: num(peak, `post_expansion_peak_${INR}cr_low`),
      high: num(peak, `post_expansion_peak_${INR}cr_high`),
      timeline: str(peak, "peak_timeline"),
      cagrLow: num(peak, "cagr_to_peak_%_low"),
      cagrHigh: num(peak, "cagr_to_peak_%_high"),
      utilLow: num(peak, "implied_capacity_utilization_%_low"),
      utilHigh: num(peak, "implied_capacity_utilization_%_high"),
      netCash: num(cash, `net_cash_${INR}cr`),
      rating:
        [str(cash, "credit_rating"), str(cash, "credit_rating_status")]
          .filter(Boolean)
          .join(" ") || null,
    },
    risks: risksFromJson(risk),
    nearCatalysts: near,
    midCatalysts: mid,
    bull: str(inv, "bull_case"),
    bear: str(inv, "bear_case"),
    anchors: scrubAnchor(str(inv, "valuation_anchors")),
    hasFinancials,
  };
}
