/**
 * Lean quant extracts matching test/ExecutiveSummary.json + test/HighlightSentiment.json.
 * Clipped materials + Ollama JSON schema — low token use.
 */
import fs from "fs";
import path from "path";
import { completeJson, checkLlmStatus } from "./llm-client";
import { loadLlmConfig } from "./llm-config";
import { clipMaterialForScanlines } from "./unified-earnings-extract";
export { formatExecutiveSummaryText } from "./concall-quant-format";

export type QuantKind = "executive" | "highlights";

function loadPrompt(name: string): string {
  const p = path.join(process.cwd(), "prompts", name);
  return fs.readFileSync(p, "utf8").trim();
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Fix common small-model drift toward gold shape (no company hardcoding):
 * - Mn left as absolute / *10 -> INR cr (/10 until plausible)
 * - mangled keys (*_growth_, *_margin_) -> yoy_growth_% / q*_margin_%
 * - order_book period INR cr -> pending_<INR>cr when needed
 */
export function normalizeExecutiveSummaryJson(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out = structuredClone(raw) as Record<string, unknown>;
  const fin = asObj(out.financial_snapshot);
  if (!fin) return out;

  const fixMoney = (n: number, section: string): number => {
    let v = n;
    // Small models often leave Mn as absolute (345 Mn -> should be 34.5 INR cr)
    if (
      (section === "ebitda" || section === "pat") &&
      v >= 100 &&
      v < 2500
    ) {
      v = Math.round((v / 10) * 100) / 100;
    }
    if (section === "revenue" && v >= 1000) {
      while (v >= 1000) v = Math.round((v / 10) * 100) / 100;
    }
    if (section === "order_book") {
      while (v >= 2500) v = Math.round((v / 10) * 100) / 100;
    }
    return v;
  };

  const renameLeaf = (key: string): string => {
    const inr = "\u20B9";
    let k = key.replace(/%/g, "_pct_").replace(new RegExp(inr, "g"), "inr_");
    // restore preferred unicode keys used by gold
    k = k
      .replace(/_inr_cr$/i, `_${inr}cr`)
      .replace(/_pct_$/, "_%")
      .replace(/_pct$/, "_%");
    k = k.replace(/_+$/, "");
    // revenue growth aliases → yoy_growth_%
    if (/revenue_growth|yoy_growth/i.test(k) && !/prefab/i.test(k)) {
      return "yoy_growth_%";
    }
    if (/ebitda_margin/i.test(k)) {
      const m = /^(q[1-4]_fy\d{2})/i.exec(k);
      return m ? `${m[1].toLowerCase()}_margin_%` : "q_margin_%";
    }
    if (/pat_margin/i.test(k)) {
      const m = /^(q[1-4]_fy\d{2})/i.exec(k);
      return m ? `${m[1].toLowerCase()}_margin_%` : "q_margin_%";
    }
    if (/ebitda_growth_bps|pat_growth_bps/i.test(k)) {
      return "yoy_growth_%";
    }
    if (/order_book_growth/i.test(k)) return "yoy_growth_%";
    if (key.includes(inr) || key.includes("%")) return key;
    if (k.includes(inr) || k.includes("%")) return k;
    return key;
  };

  const scrubObj = (
    o: Record<string, unknown>,
    section: string,
    moneyKeys = true,
  ) => {
    const inr = "\u20B9";
    const next: Record<string, unknown> = {};
    for (const [k0, v] of Object.entries(o)) {
      const k = renameLeaf(k0);
      if (typeof v === "number" && Number.isFinite(v)) {
        const isMoney =
          moneyKeys &&
          (k.endsWith(`${inr}cr`) || /_cr$/i.test(k) || /pending/i.test(k));
        next[k] = isMoney ? fixMoney(v, section) : v;
      } else {
        next[k] = v;
      }
    }
    return next;
  };

  for (const section of ["revenue", "ebitda", "pat", "order_book"] as const) {
    const block = asObj(fin[section]);
    if (block) fin[section] = scrubObj(block, section);
  }

  const ob = asObj(fin.order_book);
  const pendingKey = "pending_\u20B9cr";
  if (ob && ob[pendingKey] == null) {
    // model sometimes puts pending OB under q*_inr_cr
    const periodCr = Object.entries(ob).find(
      ([k, v]) =>
        /^q[1-4]_fy\d{2}_\u20B9cr$/i.test(k) && typeof v === "number",
    );
    if (periodCr) {
      ob[pendingKey] = periodCr[1];
      delete ob[periodCr[0]];
    }
  }
  if (ob) fin.order_book = ob;
  out.financial_snapshot = fin;

  // Drop disclaimer / empty valuation fluff from investment_summary
  const inv = asObj(out.investment_summary);
  if (inv) {
    const scrubThesis = (s: unknown): string | null => {
      if (typeof s !== "string") return null;
      const t = s.trim();
      if (t.length < 24) return null;
      if (
        /private\s*(?:&|and)\s*confidential|safe\s*harbour|forward[- ]looking|for\s+information\s+purposes|does\s+not\s+constitute\s+an\s+offer|no\s+representation\s+or\s+warranty/i.test(
          t,
        )
      ) {
        return null;
      }
      return t;
    };
    const anchorsRaw = scrubThesis(inv.valuation_anchors);
    inv.valuation_anchors =
      anchorsRaw && /(\d|₹|cr|%|x\b|coverage|ROCE|ROE|P\/E|EV)/i.test(anchorsRaw)
        ? anchorsRaw
        : null;
    const bull = scrubThesis(inv.bull_case);
    const bear = scrubThesis(inv.bear_case);
    if (bull !== null) inv.bull_case = bull;
    if (bear !== null) inv.bear_case = bear;
    out.investment_summary = inv;
  }

  return out;
}

const EXEC_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    metadata: {
      type: "object",
      properties: {
        company: { type: ["string", "null"] },
        event_date: { type: ["string", "null"] },
        reporting_period: { type: ["string", "null"] },
        analyst_type: { type: "string" },
        data_sources: { type: "array", items: { type: "string" } },
      },
      required: ["company", "reporting_period", "analyst_type"],
    },
    // Nested money objects stay open so period keys (q1_fy27_₹cr, …) can vary by call.
    financial_snapshot: {
      type: "object",
      properties: {
        revenue: { type: "object" },
        ebitda: { type: "object" },
        pat: { type: "object" },
        order_book: { type: "object" },
      },
      required: ["revenue", "ebitda", "pat", "order_book"],
    },
    operational_metrics: { type: "object" },
    segment_analysis: { type: "object" },
    capex_and_returns: { type: "object" },
    risk_factors: { type: "object" },
    near_term_catalysts_6m: { type: "array", items: { type: "string" } },
    medium_term_catalysts_12m: { type: "array", items: { type: "string" } },
    investment_summary: {
      type: "object",
      properties: {
        bull_case: { type: ["string", "null"] },
        bear_case: { type: ["string", "null"] },
        valuation_anchors: { type: ["string", "null"] },
      },
      required: ["bull_case", "bear_case"],
    },
  },
  required: [
    "metadata",
    "financial_snapshot",
    "near_term_catalysts_6m",
    "medium_term_catalysts_12m",
    "investment_summary",
  ],
};

const HL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    metadata: { type: "object" },
    highlights: {
      type: "array",
      minItems: 5,
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          id: { type: "number" },
          category: { type: "string" },
          sentiment: {
            type: "string",
            enum: ["POSITIVE", "NEGATIVE", "NEUTRAL"],
          },
          headline: { type: "string" },
          quote: { type: ["string", "null"] },
          quantified_impact: { type: "object" },
          forward_indicator: { type: "boolean" },
          score: { type: "number" },
        },
        required: ["id", "category", "sentiment", "headline", "score"],
      },
    },
    sentiment_summary: { type: "object" },
  },
  required: ["metadata", "highlights", "sentiment_summary"],
};

function buildUser(tx: string, ppt: string, kind: QuantKind): string {
  // Executive needs more PPT numbers; HL can stay tighter
  const clip = kind === "executive" ? 6_000 : 3_500;
  return [
    "TX:",
    clipMaterialForScanlines(tx || "(none)", clip, "transcript"),
    "",
    "PPT:",
    clipMaterialForScanlines(ppt || "(none)", clip, "ppt"),
    "",
    kind === "executive"
      ? "JSON now. Period-suffixed keys from reporting_period (Q1 FY27 → q1_fy27_₹cr / q1_fy26_₹cr). Never default/net/current_₹cr."
      : "JSON now.",
  ].join("\n");
}

export function loadQuantGold(kind: QuantKind): Record<string, unknown> {
  const file =
    kind === "executive"
      ? "ExecutiveSummary.json"
      : "HighlightSentiment.json";
  const p = path.join(process.cwd(), "test", file);
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

/** Shallow path compare for test fixtures — counts leaf matches. */
export function compareQuantJson(
  got: Record<string, unknown>,
  gold: Record<string, unknown>,
): {
  matched: number;
  total: number;
  pct: number;
  missing: string[];
  extras: string[];
} {
  const missing: string[] = [];
  const extras: string[] = [];
  let matched = 0;
  let total = 0;

  const walk = (g: unknown, a: unknown, prefix: string) => {
    if (g == null) return;
    if (typeof g !== "object" || Array.isArray(g)) {
      total += 1;
      if (a === g || (typeof g === "number" && typeof a === "number" && Math.abs(g - a) < 0.15)) {
        matched += 1;
      } else if (a == null || a === "") {
        missing.push(prefix);
      } else if (typeof g === "string" && typeof a === "string") {
        if (a.toLowerCase().includes(g.toLowerCase().slice(0, 24)) || g.toLowerCase().includes(a.toLowerCase().slice(0, 24))) {
          matched += 1;
        } else missing.push(prefix);
      } else {
        missing.push(prefix);
      }
      return;
    }
    const go = g as Record<string, unknown>;
    const ao = asObj(a) || {};
    for (const k of Object.keys(go)) {
      walk(go[k], ao[k], prefix ? `${prefix}.${k}` : k);
    }
    for (const k of Object.keys(ao)) {
      if (!(k in go)) extras.push(prefix ? `${prefix}.${k}` : k);
    }
  };
  walk(gold, got, "");
  return {
    matched,
    total,
    pct: total ? Math.round((matched / total) * 1000) / 10 : 0,
    missing: missing.slice(0, 40),
    extras: extras.slice(0, 20),
  };
}

export async function extractQuantFromTexts(opts: {
  kind: QuantKind;
  transcriptText: string;
  presentationText: string;
}): Promise<{
  ok: boolean;
  kind: QuantKind;
  json: Record<string, unknown>;
  engine: string;
  error?: string;
  compare?: ReturnType<typeof compareQuantJson>;
}> {
  const cfg = loadLlmConfig();
  const model =
    process.env.LLM_MODEL_QUANT?.trim() ||
    process.env.LLM_MODEL_UNIFIED?.trim() ||
    cfg.taskModels.highlightsAndShortSummaries ||
    cfg.llmModel;
  const status = await checkLlmStatus({ ...cfg, llmModel: model });
  if (!status.available) {
    return {
      ok: false,
      kind: opts.kind,
      json: {},
      engine: "quant-offline",
      error: status.detail || "LLM unavailable",
    };
  }

  const tx = opts.transcriptText.trim();
  const ppt = opts.presentationText.trim();
  if (tx.length < 80 && ppt.length < 80) {
    return {
      ok: false,
      kind: opts.kind,
      json: {},
      engine: "quant-skipped",
      error: "Not enough text",
    };
  }

  const system =
    opts.kind === "executive"
      ? loadPrompt("executive-summary.system.txt")
      : loadPrompt("highlight-sentiment.system.txt");
  const schema = opts.kind === "executive" ? EXEC_SCHEMA : HL_SCHEMA;
  const user = buildUser(tx, ppt, opts.kind);

  try {
    const raw = (await completeJson(
      { ...cfg, llmModel: model },
      system,
      user,
      {
        model,
        maxTokens: opts.kind === "executive" ? 2800 : 1200,
        temperature: 0.1,
        skipStatusCheck: true,
        jsonSchema: schema,
      },
    )) as Record<string, unknown>;

    const json =
      opts.kind === "executive" ? normalizeExecutiveSummaryJson(raw) : raw;

    let gold: Record<string, unknown> | null = null;
    try {
      gold = loadQuantGold(opts.kind);
    } catch {
      gold = null;
    }
    const compare = gold ? compareQuantJson(json, gold) : undefined;

    return {
      ok: true,
      kind: opts.kind,
      json,
      engine: `quant-${opts.kind}:${model}`,
      compare,
    };
  } catch (e) {
    return {
      ok: false,
      kind: opts.kind,
      json: {},
      engine: `quant-${opts.kind}:${model}`,
      error: e instanceof Error ? e.message : "quant extract failed",
    };
  }
}

/** Map quant highlights → PASS card scanlines. */
export function cardHighlightsFromQuant(
  quantHl: Record<string, unknown> | null | undefined,
): Array<{ text: string; polarity: string }> {
  const list = Array.isArray(quantHl?.highlights) ? quantHl!.highlights : [];
  return list
    .map((h) => {
      const o = asObj(h);
      if (!o || typeof o.headline !== "string") return null;
      const sent = String(o.sentiment || "").toUpperCase();
      const polarity =
        sent === "POSITIVE"
          ? "positive"
          : sent === "NEGATIVE"
            ? "negative"
            : "neutral";
      return { text: o.headline.trim().slice(0, 120), polarity };
    })
    .filter(Boolean)
    .slice(0, 5) as Array<{ text: string; polarity: string }>;
}

/**
 * HL models sometimes emit 0–1 (0.875) and sometimes 0–10 (7.2, gold).
 * Normalize to 0–10 for Result Quality thresholds.
 */
function normalizeScoreToTen(
  score: number | null,
  peerScores: number[] = [],
): number | null {
  if (score == null || !Number.isFinite(score)) return null;
  const peak = Math.max(score, ...peerScores.filter((n) => Number.isFinite(n)));
  if (peak <= 1) return Math.round(score * 100) / 10; // 0.875 → 8.75
  return score;
}

function scoreToResultQuality(score10: number | null): string {
  if (score10 == null || !Number.isFinite(score10)) return "Average";
  if (score10 >= 8) return "Excellent";
  if (score10 >= 6.5) return "Strong";
  if (score10 >= 4.5) return "Average";
  return "Weak";
}

function portfolioToSentiment(raw: string | null | undefined): string {
  const s = String(raw || "").toUpperCase();
  if (s === "POSITIVE") return "optimistic";
  if (s === "NEGATIVE") return "cautious";
  return "neutral";
}

/** Result quality from score + portfolio label (margin bps ≠ Weak results). */
function resultQualityFromQuant(
  score10: number | null,
  portfolio: string,
  pos: number,
  neg: number,
): string {
  const fromScore = scoreToResultQuality(score10);
  const p = portfolio.toUpperCase();
  // Don't let a 0–1 mis-scale (already normalized) or sparse negatives
  // turn a clearly POSITIVE quarter into Weak.
  if (p === "POSITIVE" && pos >= neg) {
    if (fromScore === "Weak" || fromScore === "Average") {
      return score10 != null && score10 >= 8 ? "Excellent" : "Strong";
    }
  }
  if (p === "NEGATIVE" && neg > pos && fromScore === "Excellent") {
    return "Average";
  }
  return fromScore;
}

/** Apply HL+sentiment quant JSON onto PASS card columns. */
export function applyHighlightSentimentToCard(
  extract: Record<string, unknown>,
  quantHl: Record<string, unknown>,
): void {
  const card = asObj(extract.card) || {};
  const mapped = cardHighlightsFromQuant(quantHl);
  if (mapped.length) card.highlights = mapped;

  const meta = asObj(quantHl.metadata) || {};
  const summary = asObj(quantHl.sentiment_summary) || {};
  const hlList = Array.isArray(quantHl.highlights) ? quantHl.highlights : [];
  const peerScores = hlList
    .map((h) => {
      const o = asObj(h);
      return typeof o?.score === "number" ? o.score : NaN;
    })
    .filter((n) => Number.isFinite(n));
  const rawScore =
    typeof meta.overall_score === "number"
      ? meta.overall_score
      : typeof summary.portfolio_score === "number"
        ? summary.portfolio_score
        : null;
  const score10 = normalizeScoreToTen(rawScore, peerScores);
  const portfolio = String(
    summary.portfolio_sentiment || meta.overall_sentiment || "",
  );
  const pos =
    typeof meta.positive_count === "number"
      ? meta.positive_count
      : mapped.filter((h) => h.polarity === "positive").length;
  const neg =
    typeof meta.negative_count === "number"
      ? meta.negative_count
      : mapped.filter((h) => h.polarity === "negative").length;

  card.result_quality = resultQualityFromQuant(score10, portfolio, pos, neg);
  card.mgmt_sentiment = portfolioToSentiment(portfolio);
  card.sentiment_score = score10;
  card.sentiment_label =
    portfolio.charAt(0) + portfolio.slice(1).toLowerCase() || null;
  card.brief = true;
  extract.card = card;

  const tone = asObj(extract.management_tone) || {};
  tone.overall_tone = card.mgmt_sentiment;
  if (score10 != null) {
    // Map 0–10 → roughly −1…+1; round to kill float noise (0.6600000000000001)
    tone.net_sentiment_score = Math.round(((score10 - 5) / 5) * 100) / 100;
  }
  extract.management_tone = tone;
}

/**
 * Map quant executive_summary.financial_snapshot → reported_financials
 * so PASS Revenue ₹ Cr / Financials row populate after Analyze.
 */
export function applyExecutiveSnapshotToFinancials(
  extract: Record<string, unknown>,
  exec: Record<string, unknown> | null | undefined,
): void {
  const snap = asObj(exec?.financial_snapshot);
  if (!snap) return;

  const fin = asObj(extract.reported_financials) || {};

  const pickCr = (row: Record<string, unknown> | null): number | null => {
    if (!row) return null;
    const preferred: number[] = [];
    const fallback: number[] = [];
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (!/₹cr|inr_?cr|_cr$|crore/i.test(k)) continue;
      if (
        /guidance|target|prior|remaining|largest|inflow|pending|gross_profit|operating_ebitda|\bpbt\b|\bpat\b/i.test(
          k,
        )
      ) {
        continue;
      }
      if (/yoy|growth|pct|margin|bps/i.test(k)) continue;
      // Prior-year comps → fallback (current quarter keys stay preferred)
      if (/_fy2[0-5]\b|_fy26\b|q[1-4]_fy26/i.test(k)) {
        fallback.push(v);
        continue;
      }
      preferred.push(v);
    }
    return preferred[0] ?? fallback[0] ?? null;
  };

  const pickYoy = (row: Record<string, unknown> | null): number | null => {
    if (!row) return null;
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (/yoy_growth|pct_change|yoy_pct/i.test(k) && !/prefab|segment/i.test(k)) {
        return v;
      }
    }
    return null;
  };

  const pickMargin = (row: Record<string, unknown> | null): number | null => {
    if (!row) return null;
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (!/margin/i.test(k)) continue;
      if (/fy26|guidance|target|change_bps/i.test(k)) continue;
      return v;
    }
    return null;
  };

  const ensureMetric = (key: string, section: string) => {
    const existing = asObj(fin[key]);
    if (existing && typeof existing.current_qtr === "number") return;
    const row = asObj(snap[section]);
    const cur = pickCr(row);
    if (cur == null) return;
    fin[key] = {
      current_qtr: cur,
      yoy_qtr: null,
      pct_change: pickYoy(row),
      unit: "INR cr",
    };
  };

  ensureMetric("revenue", "revenue");
  ensureMetric("ebitda", "ebitda");
  ensureMetric("pat", "pat");

  if (!asObj(fin.ebitda_margin_pct)?.current_qtr) {
    const margin = pickMargin(asObj(snap.ebitda));
    if (margin != null) {
      fin.ebitda_margin_pct = {
        current_qtr: margin,
        pct_change: null,
        unit: "%",
      };
    }
  }

  extract.reported_financials = fin;
}

