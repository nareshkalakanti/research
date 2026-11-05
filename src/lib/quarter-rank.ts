/**
 * Compact quarters rank from panel YoY/QoQ — same growth mean idea as PEAD FF,
 * plus overall trend badge. Pure — no I/O, no issuer facts.
 */
import { peadScoreFfMonitor } from "./pead-score";
import {
  fmtYoYPct,
  qoqFromPanel,
  yoyFromPanel,
  type PanelYoY,
  type QuarterPanel,
} from "./quarter-panel";
import {
  classifyQuarterTrend,
  overallTrendLabel,
  type QtrTrendSignal,
} from "./quarter-trend";

export type QuarterRankMetric = {
  id: string;
  label: string;
  value: string;
  /** Positive growth / improving. */
  tone: "good" | "bad" | "neutral";
};

export type QuarterRankResult = {
  /** Mean of available Sales YoY/QoQ (NP then OP fallback) — FF monitor without PE. */
  score: number;
  signal: QtrTrendSignal;
  ratingLabel: string;
  reason: string;
  metrics: QuarterRankMetric[];
};

function toneForPct(v: number | null): "good" | "bad" | "neutral" {
  if (v == null || !Number.isFinite(v)) return "neutral";
  if (v > 0) return "good";
  if (v < 0) return "bad";
  return "neutral";
}

function metric(
  id: string,
  label: string,
  v: number | null,
): QuarterRankMetric | null {
  if (v == null || !Number.isFinite(v)) return null;
  return {
    id,
    label,
    value: fmtYoYPct(v),
    tone: toneForPct(v),
  };
}

/**
 * Rank a quarter panel: growth score + Growing / Mixed / Declining.
 * Returns null when there is too little data to score.
 */
export function quarterRankFromPanel(
  panel: QuarterPanel,
  yoyHint?: PanelYoY | null,
): QuarterRankResult | null {
  const yoy = yoyHint ?? yoyFromPanel(panel);
  const qoq = qoqFromPanel(panel);
  const salesY = yoy?.sales_yoy ?? null;
  const salesQ = qoq?.sales_qoq ?? null;
  const npY = yoy?.np_yoy ?? null;
  const npQ = qoq?.np_qoq ?? null;
  const ebidtY = yoy?.ebidt_yoy ?? null;
  const ebidtQ = qoq?.ebidt_qoq ?? null;

  const score =
    peadScoreFfMonitor(salesY, salesQ, null) ??
    peadScoreFfMonitor(npY, npQ, null) ??
    peadScoreFfMonitor(ebidtY, ebidtQ, null);
  if (score == null) return null;

  const trend = classifyQuarterTrend(panel, yoy);
  const signal: QtrTrendSignal = trend?.signal ?? "Inconsistent";
  const metrics = [
    metric("sales_yoy", "Sales YoY", salesY),
    metric("sales_qoq", "Sales QoQ", salesQ),
    metric("np_yoy", "NP YoY", npY),
    metric("np_qoq", "NP QoQ", npQ),
  ].filter((m): m is QuarterRankMetric => m != null);

  return {
    score,
    signal,
    ratingLabel: overallTrendLabel(signal),
    reason: trend?.reason ?? "Growth mean from latest quarters.",
    metrics,
  };
}

export function quarterRankRatingClass(signal: QtrTrendSignal): string {
  if (signal === "Growing") return "seven-rule-rating--buy";
  if (signal === "Declining") return "seven-rule-rating--sell";
  return "seven-rule-rating--hold";
}
