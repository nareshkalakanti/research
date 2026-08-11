/**
 * Distress / turnaround score — rule-based (stocks-ai port).
 */
import {
  DISTRESS_DRAWDOWN_MIN_PCT,
  DISTRESS_MCAP_SWEET_MAX_CR,
  DISTRESS_SEED_TICKERS,
} from "./config";

export type DistressMetrics = {
  ticker: string;
  yf_symbol: string;
  price: number | null;
  mcap_cr: number | null;
  pe: number | null;
  pb: number | null;
  eps_yoy: number | null;
  sales_yoy: number | null;
  returns_pct: number | null;
  w52_high: number | null;
  w52_low: number | null;
  drawdown_pct: number | null;
  bounce_pct: number | null;
  surv_type: string;
  surv_stage: string | null;
};

export type DistressScoreResult = {
  distress_score: number;
  distress_flags: string[];
  distress_reason: string;
  is_seed: boolean;
  metrics: DistressMetrics;
};

function stagePenalty(survType: string, survStage: string | null): number {
  const text = `${survType} ${survStage ?? ""}`.toUpperCase();
  if (text.includes("SEED") || text.includes("MONITOR")) return 0;
  if (text.includes("GSM")) {
    if (/IV|STAGE 4|STAGE IV/.test(text)) return 18;
    if (/III|STAGE 3|STAGE III/.test(text)) return 12;
    if (/II|STAGE 2|STAGE II/.test(text)) return 6;
    return 4;
  }
  if (text.includes("ASM")) {
    if (/IV|4/.test(text)) return 10;
    if (/III|3/.test(text)) return 6;
    return 0;
  }
  return 2;
}

function baseDistressSignals(m: DistressMetrics): string[] {
  const flags: string[] = [];
  if (m.eps_yoy != null && m.eps_yoy < 0) flags.push("neg_eps_yoy");
  if (m.pe != null && (m.pe >= 80 || m.pe >= 900)) flags.push("stressed_pe");
  if (
    m.drawdown_pct != null &&
    m.drawdown_pct <= -Math.abs(DISTRESS_DRAWDOWN_MIN_PCT)
  ) {
    flags.push("drawdown");
  }
  if (m.sales_yoy != null && m.sales_yoy < -15) flags.push("sales_pressure");
  if (m.surv_type && m.surv_type !== "SEED" && m.surv_type !== "—") {
    flags.push("surveillance");
  }
  return flags;
}

export function scoreDistressTurnaround(
  metrics: DistressMetrics,
): DistressScoreResult {
  const ticker = metrics.ticker.toUpperCase();
  const isSeed = (DISTRESS_SEED_TICKERS as readonly string[]).includes(ticker);
  const coreFlags = baseDistressSignals(metrics);
  const flags = [...coreFlags];

  if (isSeed) flags.unshift("seed");

  if (
    metrics.sales_yoy != null &&
    metrics.eps_yoy != null &&
    metrics.sales_yoy > metrics.eps_yoy + 10
  ) {
    flags.push("sales_gt_eps");
  }
  if (metrics.bounce_pct != null && metrics.bounce_pct >= 15) {
    flags.push("bounce");
  }
  if (metrics.pe != null && metrics.pe > 0 && metrics.pe <= 18) {
    flags.push("cheap_pe");
  }
  if (
    metrics.mcap_cr != null &&
    metrics.mcap_cr <= DISTRESS_MCAP_SWEET_MAX_CR
  ) {
    flags.push("small_cap");
  }

  if (!isSeed && coreFlags.length === 0) {
    return {
      distress_score: 0,
      distress_flags: [...new Set(flags)],
      distress_reason: "no_distress",
      is_seed: false,
      metrics,
    };
  }

  let score = isSeed ? 30 : 22;
  const dd = metrics.drawdown_pct;
  const bounce = metrics.bounce_pct;
  const eps = metrics.eps_yoy;
  const sales = metrics.sales_yoy;
  const returns = metrics.returns_pct;
  const pe = metrics.pe;
  const pb = metrics.pb;
  const mcap = metrics.mcap_cr;

  if (dd != null) {
    if (dd >= -70 && dd <= -20) score += 18;
    else if (dd >= -85 && dd < -70) score += 10;
    else if (dd > -20 && dd <= -10) score += 6;
  }

  if (bounce != null) {
    if (bounce >= 80) score += 22;
    else if (bounce >= 40) score += 16;
    else if (bounce >= 15) score += 10;
    else if (bounce >= 5) score += 5;
  }

  if (sales != null && eps != null && sales > eps + 10) score += 18;
  else if (sales != null && sales >= 0) score += 10;
  else if (sales != null && sales > -15) score += 5;

  if (returns != null) {
    if (returns >= 40) score += 22;
    else if (returns >= 10) score += 12;
    else if (returns >= 0) score += 5;
    else if (returns <= -25) score -= 6;
  }

  if (pe != null) {
    if (pe >= 900) score += 6;
    else if (pe >= 80) score += 4;
    else if (pe > 0 && pe <= 18) score += 8;
  }

  if (pb != null && pb > 0 && pb <= 3.5) score += 6;

  if (mcap != null) {
    if (mcap <= DISTRESS_MCAP_SWEET_MAX_CR) score += 8;
    else if (mcap <= 2000) score += 4;
    else if (mcap >= 10000) score -= 4;
  }

  score -= stagePenalty(metrics.surv_type, metrics.surv_stage);
  score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));

  const reasonBits: string[] = [];
  if (isSeed) reasonBits.push("seed");
  if (metrics.surv_type && metrics.surv_type !== "SEED" && metrics.surv_type !== "—") {
    reasonBits.push(metrics.surv_type.toLowerCase());
  }
  if (dd != null) reasonBits.push(`dd${dd.toFixed(0)}`);
  if (sales != null && eps != null && sales > eps) reasonBits.push("sales>eps");

  return {
    distress_score: score,
    distress_flags: [...new Set(flags)],
    distress_reason: reasonBits.join("|") || "watch",
    is_seed: isSeed,
    metrics,
  };
}
