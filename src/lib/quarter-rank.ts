/**
 * Compact quarters rank from panel YoY/QoQ: a 0–10 growth score that blends
 * Sales and Net Profit growth, with a label derived from the same score.
 * Pure — no I/O, no issuer facts.
 */
import {
  fmtYoYPct,
  qoqFromPanel,
  yoyFromPanel,
  type PanelYoY,
  type QuarterPanel,
} from "./quarter-panel";

export type QuarterRankMetric = {
  id: string;
  label: string;
  value: string;
  /** Positive growth / improving. */
  tone: "good" | "bad" | "neutral";
  /** Share of the score this metric carries (0–1, renormalised). */
  weight: number;
  /** This metric's 0–10 sub-score. */
  points: number;
};

export type QuarterRankBand = "Strong" | "Growing" | "Mixed" | "Weak";

export type QuarterRankResult = {
  /** 0–10 growth score (5 = flat, 10 = ≥ +25% on everything, 0 = ≤ −25%). */
  score: number;
  band: QuarterRankBand;
  ratingLabel: string;
  /** Plain-English one-liner, e.g. "Sales +6.5% YoY · Profit −28.4% YoY". */
  summary: string;
  metrics: QuarterRankMetric[];
};

/** ±25% growth maps to the ends of the 0–10 scale. */
const PCT_AT_EXTREME = 25;

/** YoY matters more than QoQ (seasonality); profit and sales equally. */
const WEIGHTS = {
  sales_yoy: 0.3,
  np_yoy: 0.3,
  sales_qoq: 0.2,
  np_qoq: 0.2,
} as const;

function pctToPoints(pct: number): number {
  const p = 5 + (pct / PCT_AT_EXTREME) * 5;
  return Math.min(10, Math.max(0, p));
}

function toneForPct(v: number): "good" | "bad" | "neutral" {
  if (v > 0) return "good";
  if (v < 0) return "bad";
  return "neutral";
}

function bandFor(score: number): QuarterRankBand {
  if (score >= 7) return "Strong";
  if (score >= 5.5) return "Growing";
  if (score >= 4) return "Mixed";
  return "Weak";
}

function finite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/**
 * Rank a quarter panel: 0–10 growth score + Strong / Growing / Mixed / Weak.
 * Returns null when there is too little data to score.
 */
export function quarterRankFromPanel(
  panel: QuarterPanel,
  yoyHint?: PanelYoY | null,
): QuarterRankResult | null {
  const yoy = yoyHint ?? yoyFromPanel(panel);
  const qoq = qoqFromPanel(panel);

  // Fall back to operating profit when net profit is unavailable.
  const npY = finite(yoy?.np_yoy) ? yoy!.np_yoy : (yoy?.ebidt_yoy ?? null);
  const npQ = finite(qoq?.np_qoq) ? qoq!.np_qoq : (qoq?.ebidt_qoq ?? null);
  const profitLabel = finite(yoy?.np_yoy) || finite(qoq?.np_qoq) ? "NP" : "OP";

  const raw: { id: keyof typeof WEIGHTS; label: string; v: number | null }[] = [
    { id: "sales_yoy", label: "Sales YoY", v: yoy?.sales_yoy ?? null },
    { id: "sales_qoq", label: "Sales QoQ", v: qoq?.sales_qoq ?? null },
    { id: "np_yoy", label: `${profitLabel} YoY`, v: npY },
    { id: "np_qoq", label: `${profitLabel} QoQ`, v: npQ },
  ];
  const avail = raw.filter((r): r is typeof r & { v: number } => finite(r.v));
  if (!avail.length) return null;

  const totalW = avail.reduce((s, r) => s + WEIGHTS[r.id], 0);
  const metrics: QuarterRankMetric[] = avail.map((r) => ({
    id: r.id,
    label: r.label,
    value: fmtYoYPct(r.v),
    tone: toneForPct(r.v),
    weight: WEIGHTS[r.id] / totalW,
    points: pctToPoints(r.v),
  }));
  const score = metrics.reduce((s, m) => s + m.points * m.weight, 0);
  const band = bandFor(score);

  const sales =
    avail.find((r) => r.id === "sales_yoy") ??
    avail.find((r) => r.id === "sales_qoq");
  const profit =
    avail.find((r) => r.id === "np_yoy") ??
    avail.find((r) => r.id === "np_qoq");
  const summary = [
    sales
      ? `Sales ${fmtYoYPct(sales.v)} ${sales.id.endsWith("yoy") ? "YoY" : "QoQ"}`
      : null,
    profit
      ? `${profitLabel === "NP" ? "Profit" : "Op. profit"} ${fmtYoYPct(profit.v)} ${profit.id.endsWith("yoy") ? "YoY" : "QoQ"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return { score, band, ratingLabel: band, summary, metrics };
}

export function quarterRankRatingClass(band: QuarterRankBand): string {
  if (band === "Strong" || band === "Growing") return "seven-rule-rating--buy";
  if (band === "Weak") return "seven-rule-rating--sell";
  return "seven-rule-rating--hold";
}
