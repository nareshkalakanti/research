import type { EvidenceBundle, EvaluationResult } from "./types";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function scoreTechnician(e: EvidenceBundle): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 50;
  const rvol = e.technicals.rvol;
  if (rvol != null) {
    if (rvol >= 3) {
      score += 25;
      reasons.push(`RVOL ${rvol}× — strong volume`);
    } else if (rvol >= 1.5) {
      score += 12;
      reasons.push(`RVOL ${rvol}× — above average`);
    } else if (rvol < 1) {
      score -= 10;
      reasons.push(`RVOL ${rvol}× — thin volume`);
    }
  }
  const pos = e.range_52w.position_pct;
  if (pos != null && pos >= 85) {
    score += 15;
    reasons.push(`52w position ${pos}% — near highs`);
  }
  if (e.technicals.trend === "up") {
    score += 10;
    reasons.push("Price above rising trend");
  } else if (e.technicals.trend === "down") {
    score -= 12;
    reasons.push("Downtrend vs SMA");
  }
  const drp = e.technicals.day_range_position_pct;
  if (drp != null && drp >= 70) {
    score += 8;
    reasons.push(`Strong close in day range (${drp}%)`);
  }
  return { score: clamp(Math.round(score), 0, 100), reasons: reasons.slice(0, 4) };
}

/** Quant tab — weekly BB NEW + TQ trend (replaces RVOL technician). */
function scoreTechnicianQuant(e: EvidenceBundle): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 45;
  const w = e.weekly;
  if (!w?.has_bb && !w?.has_tq) {
    return { score: 35, reasons: ["No weekly BB/TQ stamp"] };
  }
  if (w.has_tq) {
    const tqScore = w.tq?.score;
    if (tqScore != null && tqScore >= 70) {
      score += 28;
      reasons.push(`TQ score ${Math.round(tqScore)} — strong trend`);
    } else if (tqScore != null && tqScore >= 55) {
      score += 18;
      reasons.push(`TQ score ${Math.round(tqScore)}`);
    } else {
      score += 12;
      reasons.push(
        w.tq?.crossover_type
          ? `TQ ${w.tq.crossover_type}`
          : "Weekly TQ signal",
      );
    }
  }
  if (w.has_bb) {
    score += 22;
    reasons.push("BB NEW weekly breakout");
  }
  if (w.has_bb && w.has_tq) {
    score += 10;
    reasons.push("TQ + BB alignment");
  }
  return { score: clamp(Math.round(score), 0, 100), reasons: reasons.slice(0, 4) };
}

function scoreBullQuant(e: EvidenceBundle): { score: number; reasons: string[] } {
  const base = scoreBull(e);
  const w = e.weekly;
  let score = base.score;
  const reasons = [...base.reasons];
  if (w?.has_tq) {
    score += 8;
    reasons.push("Weekly TQ trend");
  }
  if (w?.has_bb) {
    score += 10;
    reasons.push("BB NEW breakout");
  }
  return { score: clamp(score, 0, 100), reasons: reasons.slice(0, 5) };
}

function judgeVerdictQuant(
  e: EvidenceBundle,
  bullScore: number,
  bearScore: number,
): EvaluationResult["verdict"] {
  const net = bullScore - bearScore;
  const w = e.weekly;
  const hasSignal = !!(w?.has_bb || w?.has_tq);
  const tqStrong = (w?.tq?.score ?? 0) >= 60;

  let verdict: "BUY" | "WATCH" | "AVOID" = "WATCH";
  if (net >= 22 && hasSignal && (w?.has_bb || tqStrong)) {
    verdict = "BUY";
  } else if (net <= -15) {
    verdict = "AVOID";
  }

  let confidence = clamp(Math.round(4 + net / 15), 1, 10);
  if (verdict === "BUY" && confidence < 7) confidence = 7;
  if (verdict !== "BUY" && confidence > 6) confidence = 6;

  const winner = net >= 0 ? "Bull" : "Bear";
  const rationale =
    verdict === "BUY"
      ? `Bull case leads (net +${net}) with weekly TQ/BB confirmation.`
      : verdict === "AVOID"
        ? `Bear case dominates (net ${net}); risk/reward unfavorable.`
        : `Mixed debate (net ${net}); wait for clearer TQ/BB follow-through.`;

  const catalyst =
    w?.has_bb && w?.has_tq
      ? "TQ + BB weekly alignment"
      : w?.has_bb
        ? "BB NEW breakout"
        : w?.has_tq
          ? "Weekly TQ trend"
          : "Needs confirmation";

  return {
    winner,
    verdict,
    confidence,
    rationale,
    key_catalyst: catalyst,
    bull_score: bullScore,
    bear_score: bearScore,
    net,
  };
}

/** Quant pipeline — Technician uses weekly BB/TQ, not RVOL. */
export function evaluateQuant(evidence: EvidenceBundle): EvaluationResult {
  const technician = scoreTechnicianQuant(evidence);
  const fundamentalist = scoreFundamentalist(evidence);
  const newsdesk = scoreNewsdesk(evidence);
  const bull = scoreBullQuant(evidence);
  const bear = scoreBear(evidence);
  const verdict = judgeVerdictQuant(evidence, bull.score, bear.score);

  return {
    scores: { technician, fundamentalist, newsdesk, bull, bear },
    verdict,
    engine: "deterministic",
  };
}

function scoreFundamentalist(e: EvidenceBundle): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 50;
  const up = e.analyst.upside_pct;
  if (up != null) {
    if (up >= 15) {
      score += 25;
      reasons.push(`Analyst upside ${up}%`);
    } else if (up >= 8) {
      score += 15;
      reasons.push(`Moderate upside ${up}%`);
    } else if (up <= 0) {
      score -= 15;
      reasons.push("No analyst headroom");
    }
  }
  const buy = e.analyst.buy_pct;
  if (buy != null && buy >= 70) {
    score += 12;
    reasons.push(`${buy}% buy ratings`);
  } else if (buy != null && buy < 45) {
    score -= 10;
    reasons.push(`Low buy conviction (${buy}%)`);
  }
  return { score: clamp(Math.round(score), 0, 100), reasons: reasons.slice(0, 4) };
}

function scoreNewsdesk(e: EvidenceBundle): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 50;
  const net = e.news.positive - e.news.negative;
  if (net >= 2) {
    score += 20;
    reasons.push(`Positive news tone (+${net})`);
  } else if (net <= -2) {
    score -= 20;
    reasons.push(`Negative news tone (${net})`);
  } else if (net === 0 && e.news.total > 0) {
    reasons.push("Mixed/neutral headlines");
  }
  if (e.news.total === 0) {
    score -= 5;
    reasons.push("No recent headlines");
  }
  return { score: clamp(Math.round(score), 0, 100), reasons: reasons.slice(0, 4) };
}

function scoreBull(e: EvidenceBundle): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 40;

  const rvol = e.technicals.rvol;
  if (rvol != null && rvol >= 1.5) {
    score += Math.min(20, Math.round(rvol * 5));
    reasons.push(`Volume confirmation RVOL ${rvol}×`);
  }
  const pos = e.range_52w.position_pct;
  if (pos != null && pos >= 85) {
    score += 18;
    reasons.push("Breakout zone (52w position ≥ 85%)");
  }
  if (e.technicals.price_vs_sma_pct != null && e.technicals.price_vs_sma_pct > 0) {
    score += 8;
    reasons.push("Above SMA");
  }
  if (e.technicals.day_range_position_pct != null && e.technicals.day_range_position_pct >= 65) {
    score += 8;
    reasons.push("Strong day-range close");
  }
  const up = e.analyst.upside_pct;
  if (up != null && up >= 10) {
    score += 12;
    reasons.push(`Analyst upside ${up}%`);
  }
  const buy = e.analyst.buy_pct;
  if (buy != null && buy >= 80) {
    score += 10;
    reasons.push(`${buy}% buy ratings`);
  }
  if (e.news.positive > e.news.negative) {
    score += 6;
    reasons.push("Positive news skew");
  }
  const wr = e.technicals.window_return_pct;
  if (wr != null && wr > 0) {
    score += Math.min(10, Math.round(wr / 2));
  }

  return { score: clamp(Math.round(score), 0, 100), reasons: reasons.slice(0, 5) };
}

function scoreBear(e: EvidenceBundle): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 35;

  const rvol = e.technicals.rvol;
  if (rvol != null && rvol < 1) {
    score += 12;
    reasons.push(`Weak RVOL ${rvol}×`);
  }
  const pos = e.range_52w.position_pct;
  if (pos != null && pos < 30) {
    score += 18;
    reasons.push("Near 52w lows");
  }
  if (e.technicals.trend === "down") {
    score += 12;
    reasons.push("Downtrend");
  }
  const up = e.analyst.upside_pct;
  if (up != null && up <= 0) {
    score += 15;
    reasons.push("No analyst upside");
  }
  const buy = e.analyst.buy_pct;
  if (buy != null && buy < 55) {
    score += 10;
    reasons.push(`Low buy % (${buy}%)`);
  }
  const pfh = e.range_52w.pct_from_high;
  if (pfh != null && pfh <= -20) {
    score += 10;
    reasons.push(`Far from 52w high (${pfh}%)`);
  }
  const sell = e.analyst.sell_pct;
  if (sell != null && sell >= 25) {
    score += 8;
    reasons.push(`High sell ratings (${sell}%)`);
  }
  if (e.news.negative > e.news.positive) {
    score += 8;
    reasons.push("Negative news skew");
  }
  if (e.technicals.day_range_position_pct != null && e.technicals.day_range_position_pct < 35) {
    score += 8;
    reasons.push("Weak close in day range");
  }

  return { score: clamp(Math.round(score), 0, 100), reasons: reasons.slice(0, 5) };
}

function judgeVerdict(
  e: EvidenceBundle,
  bullScore: number,
  bearScore: number,
): EvaluationResult["verdict"] {
  const net = bullScore - bearScore;
  const pos = e.range_52w.position_pct ?? 0;
  const rvol = e.technicals.rvol ?? 0;

  let verdict: "BUY" | "WATCH" | "AVOID" = "WATCH";
  if (net >= 25 && (pos >= 60 || rvol >= 3)) {
    verdict = "BUY";
  } else if (net <= -15) {
    verdict = "AVOID";
  }

  let confidence = clamp(Math.round(4 + net / 15), 1, 10);
  if (verdict === "BUY" && confidence < 7) confidence = 7;
  if (verdict !== "BUY" && confidence > 6) confidence = 6;

  const winner = net >= 0 ? "Bull" : "Bear";
  const rationale =
    verdict === "BUY"
      ? `Bull case leads (net +${net}) with momentum/volume confirmation.`
      : verdict === "AVOID"
        ? `Bear case dominates (net ${net}); risk/reward unfavorable.`
        : `Mixed debate (net ${net}); wait for clearer confirmation.`;

  const catalyst =
    verdict === "BUY"
      ? bullScore >= bearScore
        ? "Volume + trend alignment"
        : "Analyst headroom"
      : bearScore > bullScore
        ? "Weak tape or sentiment"
        : "Needs confirmation";

  return {
    winner,
    verdict,
    confidence,
    rationale,
    key_catalyst: catalyst,
    bull_score: bullScore,
    bear_score: bearScore,
    net,
  };
}

/** Deterministic panel — always works offline. */
export function evaluateDeterministic(evidence: EvidenceBundle): EvaluationResult {
  const technician = scoreTechnician(evidence);
  const fundamentalist = scoreFundamentalist(evidence);
  const newsdesk = scoreNewsdesk(evidence);
  const bull = scoreBull(evidence);
  const bear = scoreBear(evidence);
  const verdict = judgeVerdict(evidence, bull.score, bear.score);

  return {
    scores: { technician, fundamentalist, newsdesk, bull, bear },
    verdict,
    engine: "deterministic",
  };
}

export function evaluate(evidence: EvidenceBundle): EvaluationResult {
  return evaluateDeterministic(evidence);
}
