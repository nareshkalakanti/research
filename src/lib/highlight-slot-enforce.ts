/**
 * Deterministic post-process after small-model highlight extraction.
 * Mistral/Qwen often emit valid JSON but wrong slot order/sentiment —
 * reorder + force WIN / RISK / STRATEGIC semantics.
 */

export type HighlightSentiment = "POSITIVE" | "NEGATIVE" | "NEUTRAL";

export type HighlightRow = {
  id: number;
  category: string;
  sentiment: HighlightSentiment;
  headline: string;
  quote: string | null;
  quantified_impact: {
    metric: string | null;
    value: number | null;
    unit: string | null;
    impact_level: "HIGH" | "MEDIUM" | "LOW";
  };
  forward_indicator: boolean;
  score: number;
  [key: string]: unknown;
};

export type HighlightSentimentJson = {
  metadata: Record<string, unknown>;
  highlights: HighlightRow[];
  sentiment_summary: {
    positive_avg_score: number | null;
    negative_avg_score: number | null;
    neutral_avg_score: number | null;
    portfolio_score: number;
    portfolio_sentiment: HighlightSentiment;
  };
};

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function num(v: unknown, fallback: number | null = null): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function blob(h: Record<string, unknown>): string {
  const qi = asObj(h.quantified_impact);
  return [
    h.category,
    h.sentiment,
    h.headline,
    h.quote,
    qi?.metric,
    h.metric,
  ]
    .map((x) => String(x || "").toLowerCase())
    .join(" ");
}

/** Lift flat metric fields into quantified_impact when models flatten the schema. */
function normalizeHighlightRow(raw: unknown, fallbackId: number): HighlightRow {
  const h = asObj(raw) || {};
  const qiIn = asObj(h.quantified_impact) || {};
  const metric =
    (typeof qiIn.metric === "string" && qiIn.metric) ||
    (typeof h.metric === "string" && h.metric) ||
    null;
  const value = num(qiIn.value ?? h.value, null);
  const unit =
    (typeof qiIn.unit === "string" && qiIn.unit) ||
    (typeof h.unit === "string" && h.unit) ||
    null;
  const levelRaw = String(
    qiIn.impact_level ?? h.impact_level ?? "MEDIUM",
  ).toUpperCase();
  const impact_level =
    levelRaw === "HIGH" || levelRaw === "LOW" ? levelRaw : "MEDIUM";

  const sentRaw = String(h.sentiment || "NEUTRAL").toUpperCase();
  const sentiment: HighlightSentiment =
    sentRaw === "POSITIVE" || sentRaw === "NEGATIVE" ? sentRaw : "NEUTRAL";

  let score = num(h.score, 5)!;
  if (score <= 1 && score > 0) score = Math.round(score * 100) / 10;

  let headline = String(h.headline || "").replace(/\s+/g, " ").trim();
  if (headline.length > 70) headline = `${headline.slice(0, 67)}...`;

  const quote =
    h.quote == null || h.quote === ""
      ? null
      : String(h.quote).replace(/\s+/g, " ").trim();

  return {
    id: num(h.id, fallbackId) ?? fallbackId,
    category: String(h.category || ""),
    sentiment,
    headline,
    quote,
    quantified_impact: { metric, value, unit, impact_level },
    forward_indicator:
      typeof h.forward_indicator === "boolean"
        ? h.forward_indicator
        : fallbackId > 1,
    score,
  };
}

function winAffinity(h: HighlightRow): number {
  const t = blob(h);
  let s = h.score;
  if (h.sentiment === "POSITIVE") s += 3;
  if (/biggest\s*win|beat|growth|revenue|pbt|pat|ebitda\s*\+|surged/.test(t))
    s += 4;
  if (/risk|compression|delay|cut|miss|headwind|challenge/.test(t)) s -= 5;
  if (/capex|mtpa|capacity|merger|acquisition|expansion/.test(t)) s -= 2;
  return s;
}

function riskAffinity(h: HighlightRow): number {
  const t = blob(h);
  let s = 10 - h.score;
  if (h.sentiment === "NEGATIVE") s += 8;
  if (/biggest\s*risk|challenge|headwind/.test(t)) s += 6;
  if (
    /margin|compression|bps|delay|cut|miss|decline|drop|pressure|cost/.test(t)
  )
    s += 5;
  if (/capex|mtpa|capacity|expansion|commission/.test(t)) s -= 4;
  if (/growth|surged|beat|\+\d/.test(t) && h.sentiment === "POSITIVE") s -= 6;
  return s;
}

function strategicAffinity(h: HighlightRow): number {
  const t = blob(h);
  let s = 0;
  if (/strateg|capex|mtpa|capacity|merger|acquisition|expansion|plant|unit/.test(
    t,
  ))
    s += 8;
  if (/forward|commission|fy2|2027|2028/.test(t)) s += 2;
  if (h.forward_indicator) s += 2;
  if (h.sentiment === "NEGATIVE" && /risk|margin/.test(t)) s -= 3;
  return s;
}

function pickDistinct(
  scores: Array<{ i: number; s: number }>,
  used: Set<number>,
): number {
  const sorted = [...scores].sort((a, b) => b.s - a.s || a.i - b.i);
  for (const row of sorted) {
    if (!used.has(row.i)) return row.i;
  }
  for (let i = 0; i < 3; i++) if (!used.has(i)) return i;
  return 0;
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

/**
 * Enforce slot assignments:
 * - Slot 1: BIGGEST WIN (POSITIVE, score 7–10)
 * - Slot 2: BIGGEST RISK (NEGATIVE, score 1–5)
 * - Slot 3: STRATEGIC (any sentiment, score 4–8)
 *
 * Uses sentiment/keyword affinity first, then score — so a high-score capex
 * line is not forced into RISK when a better risk candidate exists.
 */
export function enforceSlotSemantics(
  data: Record<string, unknown>,
): HighlightSentimentJson {
  const metaIn = asObj(data.metadata) || {};
  const rawList = Array.isArray(data.highlights) ? data.highlights : [];
  const normalized = rawList
    .slice(0, 3)
    .map((h, i) => normalizeHighlightRow(h, i + 1));

  while (normalized.length < 3) {
    normalized.push(
      normalizeHighlightRow(
        {
          headline: "Insufficient detail in materials",
          sentiment: "NEUTRAL",
          score: 5,
          category: "STRATEGIC",
        },
        normalized.length + 1,
      ),
    );
  }

  const winScores = normalized.map((h, i) => ({ i, s: winAffinity(h) }));
  const riskScores = normalized.map((h, i) => ({ i, s: riskAffinity(h) }));
  const stratScores = normalized.map((h, i) => ({
    i,
    s: strategicAffinity(h),
  }));

  // Assign STRATEGIC before RISK when a clear capex/capacity candidate exists,
  // otherwise a high-score plant line becomes the "lowest score risk".
  const used = new Set<number>();
  const bestStrat = [...stratScores].sort((a, b) => b.s - a.s)[0];
  const stratIdx =
    bestStrat && bestStrat.s >= 6
      ? pickDistinct(stratScores, used)
      : -1;
  if (stratIdx >= 0) used.add(stratIdx);

  const winIdx = pickDistinct(winScores, used);
  used.add(winIdx);

  const riskIdx = pickDistinct(riskScores, used);
  used.add(riskIdx);

  const finalStratIdx =
    stratIdx >= 0 ? stratIdx : pickDistinct(stratScores, used);

  const win = { ...normalized[winIdx]! };
  win.id = 1;
  win.category = "BIGGEST WIN";
  win.sentiment = "POSITIVE";
  win.score = clamp(win.score < 7 ? 8 : win.score, 7, 10);
  win.forward_indicator =
    typeof win.forward_indicator === "boolean" ? win.forward_indicator : false;

  const risk = { ...normalized[riskIdx]! };
  risk.id = 2;
  risk.category = "BIGGEST RISK";
  risk.sentiment = "NEGATIVE";
  risk.score = clamp(risk.score > 5 ? 4 : risk.score, 1, 5);
  risk.forward_indicator =
    typeof risk.forward_indicator === "boolean" ? risk.forward_indicator : true;

  const strat = { ...normalized[finalStratIdx]! };
  strat.id = 3;
  strat.category = "STRATEGIC";
  strat.score = clamp(strat.score, 4, 8);
  if (!["POSITIVE", "NEGATIVE", "NEUTRAL"].includes(strat.sentiment)) {
    strat.sentiment = "NEUTRAL";
  }
  strat.forward_indicator =
    typeof strat.forward_indicator === "boolean"
      ? strat.forward_indicator
      : true;

  for (const h of [win, risk, strat]) {
    if (h.headline.length > 70) h.headline = `${h.headline.slice(0, 67)}...`;
  }

  const reordered = [win, risk, strat];
  const positive_scores = reordered
    .filter((h) => h.sentiment === "POSITIVE")
    .map((h) => h.score);
  const negative_scores = reordered
    .filter((h) => h.sentiment === "NEGATIVE")
    .map((h) => h.score);
  const neutral_scores = reordered
    .filter((h) => h.sentiment === "NEUTRAL")
    .map((h) => h.score);

  const portfolio_score =
    Math.round(
      ((reordered[0]!.score + reordered[1]!.score + reordered[2]!.score) / 3) *
        10,
    ) / 10;
  const portfolio_sentiment: HighlightSentiment =
    portfolio_score >= 6.5
      ? "POSITIVE"
      : portfolio_score < 4.0
        ? "NEGATIVE"
        : "NEUTRAL";

  const sentiment_summary = {
    positive_avg_score: avg(positive_scores),
    negative_avg_score: avg(negative_scores),
    neutral_avg_score: avg(neutral_scores),
    portfolio_score,
    portfolio_sentiment,
  };

  const metadata: Record<string, unknown> = {
    ...metaIn,
    total_highlights: 3,
    positive_count: positive_scores.length,
    negative_count: negative_scores.length,
    neutral_count: neutral_scores.length,
    overall_sentiment: portfolio_sentiment,
    overall_score: portfolio_score,
  };

  return {
    metadata,
    highlights: reordered,
    sentiment_summary,
  };
}

/** Schema checks after enforcement — production gate. */
export function validateHighlightSchema(data: unknown): {
  ok: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  const root = asObj(data);
  if (!root) return { ok: false, issues: ["root not object"] };

  const meta = asObj(root.metadata);
  if (!meta) issues.push("missing metadata");

  const hs = Array.isArray(root.highlights) ? root.highlights : null;
  if (!hs || hs.length !== 3) {
    issues.push(`highlights want 3 got ${hs?.length ?? 0}`);
  }

  const cats = ["BIGGEST WIN", "BIGGEST RISK", "STRATEGIC"];
  const scores: number[] = [];
  hs?.forEach((raw, i) => {
    const h = asObj(raw);
    if (!h) {
      issues.push(`H${i + 1} not object`);
      return;
    }
    if (h.category !== cats[i]) {
      issues.push(`H${i + 1} category=${h.category}`);
    }
    if (i === 0 && h.sentiment !== "POSITIVE") issues.push("H1 not POSITIVE");
    if (i === 1 && h.sentiment !== "NEGATIVE") issues.push("H2 not NEGATIVE");
    const hl = String(h.headline || "");
    if (!hl) issues.push(`H${i + 1} empty headline`);
    if (hl.length > 70) issues.push(`H${i + 1} headline ${hl.length}>70`);
    if (typeof h.forward_indicator !== "boolean") {
      issues.push(`H${i + 1} missing forward_indicator`);
    }
    const sc = num(h.score);
    if (sc == null) issues.push(`H${i + 1} missing score`);
    else scores.push(sc);
    const qi = asObj(h.quantified_impact);
    if (!qi) issues.push(`H${i + 1} missing quantified_impact`);
    else if (!qi.impact_level) issues.push(`H${i + 1} missing impact_level`);
  });

  const sum = asObj(root.sentiment_summary);
  if (!sum) issues.push("missing sentiment_summary");
  else if (num(sum.portfolio_score) == null) {
    issues.push("missing portfolio_score");
  } else if (scores.length === 3) {
    const expected =
      Math.round(((scores[0]! + scores[1]! + scores[2]!) / 3) * 10) / 10;
    if (Math.abs(num(sum.portfolio_score)! - expected) > 0.2) {
      issues.push(`portfolio_score ${sum.portfolio_score} != ${expected}`);
    }
  }

  return { ok: issues.length === 0, issues };
}
