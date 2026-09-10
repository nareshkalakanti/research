/**
 * Dual-PDF card LLM — StockScans scanlines from Transcript + PPT text.
 * Prompt: prompts/concall-scanlines.system.txt (generic — no company hardcoding).
 * Set CONCALL_UNIFIED_LLM=0 to disable.
 */
import fs from "fs";
import path from "path";
import { completeJson, checkLlmStatus } from "./llm-client";
import { loadLlmConfig } from "./llm-config";
import { parseOrderSizeToCr } from "./orderbook-screen";

export type UnifiedEarningsExtract = Record<string, unknown>;

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function mnToCr(mn: number | null): number | null {
  if (mn == null) return null;
  return Math.round((mn / 10) * 100) / 100;
}

/** Same unit rules as orderbook: Mn→Cr (/10), Lacs→Cr (/100), Cr as-is. */
function amountToCr(raw: string): number | null {
  const t = raw.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  // Ensure currency token so parseOrderSizeToCr accepts "3658 Mn"
  const labeled = /(?:INR|Rs\.?|₹)/i.test(t) ? t : `INR ${t}`;
  return parseOrderSizeToCr(labeled);
}

/**
 * Pull absolute ₹ Cr + YoY from scanline text (authoritative vs LLM financials bag).
 * Fixes: LLM stuffing 23.9% YoY into revenue_cr while highlight says Rs 3,658 Mn.
 */
function printsFromScanlines(lines: string[]): {
  revenue_cr: number | null;
  yoy_revenue_pct: number | null;
  ebitda_cr: number | null;
  yoy_ebitda_pct: number | null;
  pat_cr: number | null;
  yoy_pat_pct: number | null;
  ebitda_margin_pct: number | null;
} {
  const out = {
    revenue_cr: null as number | null,
    yoy_revenue_pct: null as number | null,
    ebitda_cr: null as number | null,
    yoy_ebitda_pct: null as number | null,
    pat_cr: null as number | null,
    yoy_pat_pct: null as number | null,
    ebitda_margin_pct: null as number | null,
  };
  for (const line of lines) {
    const t = line.replace(/,/g, "");
    const yoy = t.match(/([\d.]+)\s*%\s*YoY/i)?.[1];
    const yoyN = yoy != null ? Number(yoy) : null;
    const amt =
      t.match(
        /(?:INR|Rs\.?|₹)\s*([\d.]+)\s*(Mn|Million|Cr|Crores?|Lacs?|Lakhs?)/i,
      ) ||
      t.match(
        /([\d.]+)\s*(Mn|Million|Cr|Crores?)\b/i,
      );
    const cr = amt
      ? amountToCr(`${amt[1]} ${amt[2]}`)
      : null;

    if (/revenue|top\s*line/i.test(t) && !/order\s*book|prefab revenue growth/i.test(t)) {
      if (cr != null) out.revenue_cr = cr;
      if (yoyN != null && Number.isFinite(yoyN)) out.yoy_revenue_pct = yoyN;
    } else if (/\bEBITDA\b/i.test(t) && !/margin/i.test(t)) {
      if (cr != null) out.ebitda_cr = cr;
      if (yoyN != null && Number.isFinite(yoyN)) out.yoy_ebitda_pct = yoyN;
    } else if (/\bPAT\b|net profit|profit after tax/i.test(t) && !/margin/i.test(t)) {
      if (cr != null) out.pat_cr = cr;
      if (yoyN != null && Number.isFinite(yoyN)) out.yoy_pat_pct = yoyN;
    } else if (/EBITDA\s*margin/i.test(t)) {
      const m = t.match(/([\d.]+)\s*%/);
      if (m) out.ebitda_margin_pct = Number(m[1]);
    }
  }
  return out;
}

/**
 * LLM often puts YoY % into *_cr. If several "cr" values look like %, drop them.
 */
function demoteYoyDisguisedAsCr(
  cr: number | null,
  yoy: number | null,
  peers: Array<number | null>,
): { cr: number | null; yoy: number | null } {
  if (cr == null) return { cr, yoy };
  const peerYoyShaped = peers.filter(
    (p) => p != null && Math.abs(p) <= 100,
  ).length;
  const looksYoy =
    Math.abs(cr) <= 100 &&
    (yoy == null || Math.abs(cr - yoy) < 0.51) &&
    peerYoyShaped >= 1;
  if (looksYoy) {
    return { cr: null, yoy: yoy ?? cr };
  }
  // Face-value Mn stuffed into revenue_cr (e.g. 3658)
  if (cr >= 400 && cr < 100_000) {
    return { cr: mnToCr(cr), yoy };
  }
  return { cr, yoy };
}

function clip(s: string, max: number): string {
  const t = s.replace(/\u0000/g, "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n\n[…truncated…]`;
}

/**
 * Prefer financial / M&A / Q&A windows over cover letters and thank-you pages.
 * Keyword-based only — no company names.
 */
export function clipMaterialForScanlines(
  text: string,
  max: number,
  role: "transcript" | "ppt",
): string {
  const raw = text.replace(/\u0000/g, "").trim();
  if (raw.length <= max) return raw;

  const patterns =
    role === "ppt"
      ? [
          /financial\s+highlights/i,
          /profit\s+(?:and|&)\s+loss|P\s*&\s*L/i,
          /quarterly\s+performance|performance\s+highlights/i,
          /revenue\s+from\s+operations|consolidated\s+operating\s+revenue/i,
          /\bEBITDA\b/i,
          /\bPAT\b|profit\s+after\s+tax|net\s+profit/i,
          /acquisition|amalgamation|merger|share\s+purchase|open\s+offer/i,
          /management\s+commentary|post\s+quarter/i,
        ]
      : [
          /question\s+and\s+answer|Q\s*&\s*A/i,
          /Moderator:/i,
          /guidance|outlook/i,
          /acquisition|merger|stake|forensic|appeal/i,
          /revenue|EBITDA|PAT|margin/i,
          /MANAGEMENT:/i,
        ];

  const windows: Array<{ i: number; score: number }> = [];
  for (const re of patterns) {
    const m = re.exec(raw);
    if (m?.index != null) {
      windows.push({
        i: m.index,
        score: /acquisition|merger|stake|forensic|financial|EBITDA|PAT|revenue/i.test(
          m[0],
        )
          ? 3
          : 1,
      });
    }
  }
  if (!windows.length) return clip(raw, max);

  windows.sort((a, b) => b.score - a.score || a.i - b.i);
  const chunk = Math.floor(max / Math.min(3, windows.length));
  const parts: string[] = [];
  const used = new Set<number>();
  for (const w of windows.slice(0, 4)) {
    const start = Math.max(0, w.i - 200);
    const bucket = Math.floor(start / chunk);
    if (used.has(bucket)) continue;
    used.add(bucket);
    parts.push(raw.slice(start, start + chunk));
    if (parts.join("\n").length >= max) break;
  }
  const out = parts.join("\n\n…\n\n").trim();
  return out.length >= Math.min(800, max / 2) ? clip(out, max) : clip(raw, max);
}

function loadScanlinesSystemPrompt(): string {
  const p = path.join(
    process.cwd(),
    "prompts",
    "concall-scanlines.system.txt",
  );
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return [
      "Return ONE JSON object only.",
      "Keys: company, quarter, result_quality{rating,strengths,weaknesses},",
      "sentiment{score,label,tone,quote,conviction}, highlights[], kpi_cards[],",
      "financials. Facts only from the text.",
    ].join(" ");
  }
}

/** Ollama structured-output schema — stops local models inventing page/content JSON. */
const SCANLINES_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    company: { type: ["string", "null"] },
    nse_symbol: { type: ["string", "null"] },
    quarter: { type: ["string", "null"] },
    fiscal_year: { type: ["string", "null"] },
    call_date: { type: ["string", "null"] },
    result_quality: {
      type: "object",
      properties: {
        rating: { type: "string" },
        strengths: { type: "array", items: { type: "string" } },
        weaknesses: { type: "array", items: { type: "string" } },
      },
      required: ["rating", "strengths", "weaknesses"],
    },
    sentiment: {
      type: "object",
      properties: {
        score: { type: "number" },
        label: { type: "string" },
        tone: { type: "string" },
        quote: { type: ["string", "null"] },
        conviction: { type: ["string", "null"] },
        emotions: { type: "array", items: { type: "string" } },
      },
      required: ["score", "label", "tone", "quote", "conviction", "emotions"],
    },
    highlights: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          polarity: {
            type: "string",
            enum: ["positive", "neutral", "negative"],
          },
        },
        required: ["text", "polarity"],
      },
    },
    kpi_cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          subtext: { type: "string" },
        },
        required: ["label", "value"],
      },
    },
    financials: {
      type: "object",
      properties: {
        revenue_cr: { type: ["number", "null"] },
        yoy_revenue_pct: { type: ["number", "null"] },
        ebitda_cr: { type: ["number", "null"] },
        yoy_ebitda_pct: { type: ["number", "null"] },
        ebitda_margin_pct: { type: ["number", "null"] },
        pat_cr: { type: ["number", "null"] },
        yoy_pat_pct: { type: ["number", "null"] },
        eps: { type: ["number", "null"] },
      },
    },
    guidance: {
      type: "object",
      properties: {
        revenue_fy_cr_low: { type: ["number", "null"] },
        revenue_fy_cr_high: { type: ["number", "null"] },
        ebitda_margin_fy_pct: { type: ["number", "null"] },
        notes: { type: "array", items: { type: "string" } },
      },
    },
    catalysts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          event: { type: "string" },
          timeline: { type: ["string", "null"] },
        },
        required: ["event"],
      },
    },
    corporate_actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          counterparty: { type: ["string", "null"] },
          stake_pct: { type: ["number", "null"] },
          deal_value_cr: { type: ["number", "null"] },
          status: { type: ["string", "null"] },
        },
        required: ["type"],
      },
    },
  },
  required: [
    "company",
    "nse_symbol",
    "result_quality",
    "sentiment",
    "highlights",
  ],
};

export type UnifiedEarningsResult = {
  ok: boolean;
  extract: UnifiedEarningsExtract;
  engine: string;
  error?: string;
};

/** ON by default. Set CONCALL_UNIFIED_LLM=0 to skip. */
export function isUnifiedLlmEnabled(): boolean {
  const v = (process.env.CONCALL_UNIFIED_LLM || "1").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/**
 * ONE card pass: 3 StockScans scanlines + light financials.
 * Uses smart clips so cover letters don't crowd out P&L / M&A.
 */
export async function extractUnifiedEarningsFromTexts(opts: {
  transcriptText: string;
  presentationText: string;
}): Promise<UnifiedEarningsResult> {
  if (!isUnifiedLlmEnabled()) {
    return {
      ok: false,
      extract: {},
      engine: "unified-llm-off",
      error: "CONCALL_UNIFIED_LLM not enabled",
    };
  }

  const cfg = loadLlmConfig();
  const model =
    process.env.LLM_MODEL_UNIFIED?.trim() ||
    cfg.taskModels.highlightsAndShortSummaries ||
    cfg.llmModel;
  const status = await checkLlmStatus({ ...cfg, llmModel: model });
  if (!status.available) {
    return {
      ok: false,
      extract: {},
      engine: "unified-llm-skipped",
      error: status.detail || "LLM unavailable",
    };
  }

  const tx = opts.transcriptText.trim();
  const ppt = opts.presentationText.trim();
  if (tx.length < 80 && ppt.length < 80) {
    return {
      ok: false,
      extract: {},
      engine: "unified-llm-skipped",
      error: "Not enough text for scanlines",
    };
  }

  const system = loadScanlinesSystemPrompt();
  const user = [
    "TRANSCRIPT (relevance-clipped):",
    clipMaterialForScanlines(tx || "(none)", 5_000, "transcript"),
    "",
    "PPT / PRESENTATION (relevance-clipped):",
    clipMaterialForScanlines(ppt || "(none)", 7_000, "ppt"),
    "",
    "Return ONE JSON object with EXACTLY these top-level keys:",
    "company, nse_symbol, quarter, fiscal_year, call_date,",
    "result_quality, sentiment, highlights, kpi_cards, financials, guidance, catalysts, corporate_actions.",
    "highlights MUST be 3–5 {text, polarity} bullets from the materials (facts only).",
    "Do NOT invent alternate shapes (no page/content/Performance_Snapshot keys).",
  ].join("\n");

  try {
    const raw = (await completeJson(
      { ...cfg, llmModel: model },
      system,
      user,
      {
        model,
        maxTokens: 1600,
        temperature: 0.1,
        skipStatusCheck: true,
        jsonSchema: SCANLINES_JSON_SCHEMA,
      },
    )) as Record<string, unknown>;

    const inferPol = (text: string, raw?: string) => {
      const pol = String(raw || "").toLowerCase();
      if (pol === "positive" || pol === "negative" || pol === "neutral")
        return pol;
      if (
        /miss|cut|reset|delay|destock|divest|decline|loss|weak|compress|headwind/i.test(
          text,
        )
      ) {
        return "negative" as const;
      }
      if (
        /grew|growth|won|win|target|acquisition completed|closed|reaffirm|investment|commission|capacity|\+\d|beat|raise/i.test(
          text,
        )
      ) {
        return "positive" as const;
      }
      return "neutral" as const;
    };

    const stripMark = (s: string) =>
      s.replace(/^[✓✔⚠⚠️•\-\*]\s*/, "").trim();

    const parseHl = (h: unknown) => {
      const o = asObj(h);
      if (o && typeof o.text === "string" && o.text.trim()) {
        const text = stripMark(o.text).slice(0, 160);
        return {
          text,
          polarity: inferPol(text, String(o.polarity || "")),
        };
      }
      if (typeof h === "string" && h.trim()) {
        const text = stripMark(h).slice(0, 160);
        return { text, polarity: inferPol(text) };
      }
      return null;
    };
    const scanlines = (
      Array.isArray(raw.highlights)
        ? raw.highlights
        : Array.isArray(raw.scanlines)
          ? raw.scanlines
          : []
    )
      .map(parseHl)
      .filter(Boolean)
      .slice(0, 5) as Array<{ text: string; polarity: string }>;

    const sent = asObj(raw.sentiment) || {};
    const rqObj = asObj(raw.result_quality) || {};
    const strengths = (
      Array.isArray(rqObj.strengths) ? rqObj.strengths : []
    )
      .filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
      .map(stripMark)
      .slice(0, 4);
    const weaknesses = (
      Array.isArray(rqObj.weaknesses) ? rqObj.weaknesses : []
    )
      .filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
      .map(stripMark)
      .slice(0, 4);

    const altHl = (
      Array.isArray(raw.key_highlights) ? raw.key_highlights : []
    )
      .map(parseHl)
      .filter(Boolean) as Array<{ text: string; polarity: string }>;
    const catalystsEarly = Array.isArray(raw.catalysts) ? raw.catalysts : [];
    const fromCatalysts = catalystsEarly
      .map((c) => {
        const o = asObj(c);
        if (!o || typeof o.event !== "string" || !o.event.trim()) return null;
        const timeline =
          typeof o.timeline === "string" && o.timeline.trim()
            ? `, ${o.timeline.trim().slice(0, 40)}`
            : "";
        return parseHl({
          text: `${o.event.trim().slice(0, 100)}${timeline}`.slice(0, 160),
          polarity: "neutral",
        });
      })
      .filter(Boolean) as Array<{ text: string; polarity: string }>;

    const seedHl =
      scanlines.length > 0
        ? scanlines
        : altHl.length > 0
          ? altHl
          : strengths.length > 0
            ? strengths.slice(0, 3).map((t) => ({
                text: t.slice(0, 160),
                polarity: "positive" as const,
              }))
            : fromCatalysts.slice(0, 3);

    if (!seedHl.length) {
      return {
        ok: false,
        extract: {},
        engine: `unified-card:${model}`,
        error: "empty highlights",
      };
    }

    const ratingRaw = String(
      rqObj.rating || raw.result_quality || "",
    ).toUpperCase();
    let displayRating = "Average";
    if (ratingRaw.startsWith("EXCELLENT")) displayRating = "Excellent";
    else if (ratingRaw.startsWith("STRONG")) displayRating = "Strong";
    else if (ratingRaw.startsWith("WEAK")) displayRating = "Weak";
    else if (ratingRaw.startsWith("AVERAGE") || ratingRaw.startsWith("ADEQUATE"))
      displayRating = "Average";
    const overall =
      displayRating === "Excellent" || displayRating === "Strong"
        ? "STRONG"
        : displayRating === "Weak"
          ? "WEAK"
          : "ADEQUATE";

    const labelRaw = String(
      sent.label || sent.tone || raw.mgmt_sentiment || "neutral",
    ).trim();
    const labelLower = labelRaw.toLowerCase();
    let sentimentLabel = "Neutral";
    if (labelLower.startsWith("bull")) sentimentLabel = "Bullish";
    else if (labelLower.startsWith("optimi")) sentimentLabel = "Optimistic";
    else if (labelLower.startsWith("caut")) sentimentLabel = "Cautious";
    else if (labelLower.startsWith("bear") || labelLower.startsWith("defens"))
      sentimentLabel = "Bearish";
    else if (labelLower.startsWith("neut")) sentimentLabel = "Neutral";
    else if (labelRaw.length > 0 && labelRaw.length < 24) {
      sentimentLabel =
        labelRaw.charAt(0).toUpperCase() + labelRaw.slice(1).toLowerCase();
    }

    let score = asNum(sent.score);
    if (score != null) {
      score = Math.round(Math.max(1, Math.min(10, score)) * 10) / 10;
    }

    const toneDetail =
      typeof sent.tone === "string" &&
      sent.tone.trim() &&
      !/^(bullish|optimistic|neutral|cautious|bearish)$/i.test(sent.tone.trim())
        ? sent.tone.trim().slice(0, 120)
        : typeof sent.tone_detail === "string"
          ? sent.tone_detail.trim().slice(0, 120)
          : null;

    const quote =
      (typeof sent.quote === "string" && sent.quote.trim()
        ? sent.quote.trim()
        : null) ||
      (Array.isArray(sent.quotes) && typeof sent.quotes[0] === "string"
        ? String(sent.quotes[0]).trim()
        : null);
    const quotes = [
      ...(quote ? [quote.slice(0, 200)] : []),
      ...(Array.isArray(sent.quotes)
        ? sent.quotes
            .filter((s): s is string => typeof s === "string" && s.trim() !== "")
            .map((s) => s.trim().slice(0, 200))
        : []),
    ].filter((q, i, a) => a.indexOf(q) === i).slice(0, 3);

    const conviction =
      typeof sent.conviction === "string" && sent.conviction.trim()
        ? sent.conviction.trim().slice(0, 160)
        : null;
    const emotions = Array.isArray(sent.emotions)
      ? sent.emotions
          .filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
          .slice(0, 4)
      : [];

    const kpiCards = (
      Array.isArray(raw.kpi_cards) ? raw.kpi_cards : []
    )
      .map((k) => {
        const o = asObj(k);
        if (!o || typeof o.label !== "string" || typeof o.value !== "string")
          return null;
        const label = o.label.trim().slice(0, 40);
        const value = o.value.trim().slice(0, 48);
        if (!label || !value) return null;
        return {
          label,
          value,
          subtext:
            typeof o.subtext === "string" ? o.subtext.trim().slice(0, 80) : "",
        };
      })
      .filter(Boolean)
      .slice(0, 4) as Array<{ label: string; value: string; subtext: string }>;

    const revCrRaw =
      asNum(asObj(raw.financials)?.revenue_cr) ?? asNum(raw.revenue_cr);
    const patCrRaw =
      asNum(asObj(raw.financials)?.pat_cr) ?? asNum(raw.pat_cr);
    const ebitdaCrRaw = asNum(asObj(raw.financials)?.ebitda_cr);
    let yoyRev =
      asNum(asObj(raw.financials)?.yoy_revenue_pct) ?? asNum(raw.yoy_revenue_pct);
    let yoyPat =
      asNum(asObj(raw.financials)?.yoy_pat_pct) ?? asNum(raw.yoy_pat_pct);
    let yoyEbitda = asNum(asObj(raw.financials)?.yoy_ebitda_pct);
    let ebitdaMargin =
      asNum(asObj(raw.financials)?.ebitda_margin_pct) ??
      asNum(raw.ebitda_margin_pct);
    const eps = asNum(asObj(raw.financials)?.eps);

    const effectiveHl = seedHl.slice(0, 5);

    // Prefer absolute prints parsed from highlights (orderbook Mn→Cr rules)
    const fromHl = printsFromScanlines(effectiveHl.map((h) => h.text));
    const revFix = demoteYoyDisguisedAsCr(revCrRaw, yoyRev, [
      ebitdaCrRaw,
      patCrRaw,
    ]);
    const ebitdaFix = demoteYoyDisguisedAsCr(ebitdaCrRaw, yoyEbitda, [
      revCrRaw,
      patCrRaw,
    ]);
    const patFix = demoteYoyDisguisedAsCr(patCrRaw, yoyPat, [
      revCrRaw,
      ebitdaCrRaw,
    ]);
    const revCr = fromHl.revenue_cr ?? revFix.cr;
    const ebitdaCr = fromHl.ebitda_cr ?? ebitdaFix.cr;
    const patCr = fromHl.pat_cr ?? patFix.cr;
    yoyRev = fromHl.yoy_revenue_pct ?? revFix.yoy;
    yoyEbitda = fromHl.yoy_ebitda_pct ?? ebitdaFix.yoy;
    yoyPat = fromHl.yoy_pat_pct ?? patFix.yoy;
    if (fromHl.ebitda_margin_pct != null) ebitdaMargin = fromHl.ebitda_margin_pct;

    const guidance = asObj(raw.guidance) || {};
    const catalysts = Array.isArray(raw.catalysts) ? raw.catalysts : [];
    const actions = Array.isArray(raw.corporate_actions)
      ? raw.corporate_actions
      : [];

    const unified: UnifiedEarningsExtract = {
      metadata: {
        company: typeof raw.company === "string" ? raw.company : null,
        nse_symbol: typeof raw.nse_symbol === "string" ? raw.nse_symbol : null,
        quarter: typeof raw.quarter === "string" ? raw.quarter : null,
        fiscal_year:
          typeof raw.fiscal_year === "string" ? raw.fiscal_year : null,
        call_date: typeof raw.call_date === "string" ? raw.call_date : null,
      },
      result_quality: {
        overall_rating: overall,
        rating: displayRating,
        strengths,
        weaknesses,
        financials: {
          revenue: {
            current_qtr_mn: revCr != null ? revCr * 10 : null,
            yoy_growth_pct: yoyRev,
          },
          ebitda: {
            current_qtr_mn: ebitdaCr != null ? ebitdaCr * 10 : null,
            yoy_growth_pct: yoyEbitda,
            margin_pct: ebitdaMargin,
          },
          pat: {
            current_qtr_mn: patCr != null ? patCr * 10 : null,
            yoy_growth_pct: yoyPat,
          },
          eps: eps != null ? { current_qtr_mn: eps, unit: "INR" } : {},
        },
      },
      management_sentiment: {
        category: sentimentLabel.toUpperCase(),
        label: sentimentLabel,
        overall_score: score,
        tone: toneDetail,
        conviction,
        key_quotes: quotes,
        tone_descriptors: emotions,
      },
      highlights: { scanlines: effectiveHl, key_highlights: effectiveHl.map((h) => h.text) },
      kpi_cards: kpiCards,
      forward_guidance: {
        revenue_guidance_range: {
          low: asNum(guidance.revenue_fy_cr_low),
          high: asNum(guidance.revenue_fy_cr_high),
          unit: "INR cr",
        },
        margin_guidance: {
          ebitda_pct: asNum(guidance.ebitda_margin_fy_pct),
        },
        explicit_caveats: Array.isArray(guidance.notes)
          ? guidance.notes.filter((n) => typeof n === "string").slice(0, 3)
          : [],
      },
      key_catalysts: catalysts
        .map((c) => {
          const o = asObj(c);
          if (!o || typeof o.event !== "string") return null;
          return {
            event: o.event.trim().slice(0, 160),
            timeline:
              typeof o.timeline === "string" ? o.timeline.trim().slice(0, 80) : null,
          };
        })
        .filter(Boolean)
        .slice(0, 5),
      corporate_actions: actions
        .map((a) => {
          const o = asObj(a);
          if (!o) return null;
          return {
            type: typeof o.type === "string" ? o.type : "other",
            target_counterparty:
              typeof o.counterparty === "string" ? o.counterparty : null,
            stake_pct: asNum(o.stake_pct),
            deal_value:
              asNum(o.deal_value_cr) != null
                ? { amount: asNum(o.deal_value_cr), unit: "INR cr" }
                : null,
            status: typeof o.status === "string" ? o.status : null,
          };
        })
        .filter(Boolean)
        .slice(0, 3),
      investor_analysis: {},
    };

    return {
      ok: true,
      extract: unified,
      engine: `unified-card:${model}`,
    };
  } catch (e) {
    return {
      ok: false,
      extract: {},
      engine: `unified-card:${model}`,
      error: e instanceof Error ? e.message : "unified card failed",
    };
  }
}

/** Map unified / card JSON onto existing Concall PASS fields. */
export function mapUnifiedEarningsToConcallExtract(
  unified: UnifiedEarningsExtract,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  const metaU = asObj(unified.metadata) || {};
  const metaB = asObj(out.metadata) || {};
  out.metadata = {
    ...metaB,
    company_name:
      (typeof metaB.company_name === "string" && metaB.company_name) ||
      (typeof metaU.company === "string" && metaU.company) ||
      null,
    nse_symbol:
      // Prefer lexical / row ticker — small models often shorten EPACKPEB → EPACK
      (typeof metaB.nse_symbol === "string" && metaB.nse_symbol) ||
      (typeof metaU.nse_symbol === "string" && metaU.nse_symbol) ||
      null,
    quarter:
      (typeof metaU.quarter === "string" && metaU.quarter) ||
      metaB.quarter ||
      null,
    fiscal_year:
      (typeof metaU.fiscal_year === "string" && metaU.fiscal_year) ||
      metaB.fiscal_year ||
      null,
    call_date:
      (typeof metaU.call_date === "string" && metaU.call_date) ||
      metaB.call_date ||
      null,
  };

  const rq = asObj(unified.result_quality) || {};
  const fin = asObj(rq.financials) || {};
  const rev = asObj(fin.revenue) || {};
  const ebitda = asObj(fin.ebitda) || {};
  const pat = asObj(fin.pat) || {};
  const finB = asObj(out.reported_financials) || {};

  let revCr =
    mnToCr(asNum(rev.current_qtr_mn)) ?? asNum(asObj(finB.revenue)?.current_qtr);
  let patCr =
    mnToCr(asNum(pat.current_qtr_mn)) ??
    asNum(asObj(finB.net_profit)?.current_qtr);
  let ebitdaCr =
    mnToCr(asNum(ebitda.current_qtr_mn)) ??
    asNum(asObj(finB.ebitda)?.current_qtr);
  let yoyRev =
    asNum(rev.yoy_growth_pct) ?? asNum(asObj(finB.revenue)?.pct_change);
  let yoyPat =
    asNum(pat.yoy_growth_pct) ?? asNum(asObj(finB.net_profit)?.pct_change);
  let yoyEbitda =
    asNum(ebitda.yoy_growth_pct) ?? asNum(asObj(finB.ebitda)?.pct_change);

  // Reconcile with highlight absolute prints (same Mn→Cr as orderbook)
  const hlTexts = (
    Array.isArray(asObj(unified.highlights)?.scanlines)
      ? (asObj(unified.highlights)!.scanlines as unknown[])
      : []
  )
    .map((h) => {
      if (typeof h === "string") return h;
      const o = asObj(h);
      return typeof o?.text === "string" ? o.text : "";
    })
    .filter(Boolean);
  const fromHl = printsFromScanlines(hlTexts);
  const revFix = demoteYoyDisguisedAsCr(revCr, yoyRev, [ebitdaCr, patCr]);
  const ebitdaFix = demoteYoyDisguisedAsCr(ebitdaCr, yoyEbitda, [revCr, patCr]);
  const patFix = demoteYoyDisguisedAsCr(patCr, yoyPat, [revCr, ebitdaCr]);
  revCr = fromHl.revenue_cr ?? revFix.cr;
  ebitdaCr = fromHl.ebitda_cr ?? ebitdaFix.cr;
  patCr = fromHl.pat_cr ?? patFix.cr;
  yoyRev = fromHl.yoy_revenue_pct ?? revFix.yoy;
  yoyEbitda = fromHl.yoy_ebitda_pct ?? ebitdaFix.yoy;
  yoyPat = fromHl.yoy_pat_pct ?? patFix.yoy;

  const reported: Record<string, unknown> = { ...finB };
  if (revCr != null || yoyRev != null) {
    reported.revenue = {
      ...(asObj(finB.revenue) || {}),
      current_qtr: revCr ?? asObj(finB.revenue)?.current_qtr ?? null,
      pct_change: yoyRev ?? asObj(finB.revenue)?.pct_change ?? null,
      unit: "INR cr",
    };
  }
  if (ebitdaCr != null || yoyEbitda != null || asNum(ebitda.margin_pct) != null) {
    reported.ebitda = {
      ...(asObj(finB.ebitda) || {}),
      current_qtr: ebitdaCr ?? asObj(finB.ebitda)?.current_qtr ?? null,
      pct_change: yoyEbitda ?? asObj(finB.ebitda)?.pct_change ?? null,
      unit: "INR cr",
    };
    const margin =
      fromHl.ebitda_margin_pct ?? asNum(ebitda.margin_pct);
    if (margin != null) {
      reported.ebitda_margin_pct = {
        ...(asObj(finB.ebitda_margin_pct) || {}),
        current_qtr: margin,
      };
    }
  }
  if (patCr != null || yoyPat != null) {
    reported.net_profit = {
      ...(asObj(finB.net_profit) || {}),
      current_qtr: patCr ?? asObj(finB.net_profit)?.current_qtr ?? null,
      pct_change: yoyPat ?? asObj(finB.net_profit)?.pct_change ?? null,
      unit: "INR cr",
    };
  }
  out.reported_financials = reported;

  if (Array.isArray(unified.key_catalysts) && unified.key_catalysts.length) {
    out.key_catalysts = unified.key_catalysts;
  }
  if (
    Array.isArray(unified.corporate_actions) &&
    unified.corporate_actions.length
  ) {
    out.corporate_actions = unified.corporate_actions;
  }
  const fgU = asObj(unified.forward_guidance);
  if (fgU) {
    out.forward_guidance = { ...(asObj(out.forward_guidance) || {}), ...fgU };
  }

  const sent = asObj(unified.management_sentiment) || {};
  const cat = String(sent.category || sent.label || "").toLowerCase();
  const score10 = asNum(sent.overall_score);
  const quotes = Array.isArray(sent.key_quotes)
    ? sent.key_quotes.filter((q): q is string => typeof q === "string")
    : [];
  const toneB = asObj(out.management_tone) || {};
  out.management_tone = {
    ...toneB,
    overall_tone: cat || toneB.overall_tone || "neutral",
    net_sentiment_score:
      score10 != null ? (score10 - 5) / 5 : toneB.net_sentiment_score ?? null,
    justification:
      quotes[0] ||
      (typeof sent.tone === "string" ? sent.tone : null) ||
      toneB.justification ||
      null,
  };

  const hlBlock = asObj(unified.highlights) || {};
  const scanlines = Array.isArray(hlBlock.scanlines) ? hlBlock.scanlines : [];
  const mappedHl = scanlines
    .map((h) => {
      if (typeof h === "string" && h.trim()) {
        return { text: h.trim().slice(0, 160), polarity: "neutral" };
      }
      const o = asObj(h);
      if (!o || typeof o.text !== "string") return null;
      const pol = String(o.polarity || "neutral").toLowerCase();
      return {
        text: o.text.trim().slice(0, 160),
        polarity:
          pol === "positive" || pol === "negative" || pol === "neutral"
            ? pol
            : "neutral",
      };
    })
    .filter(Boolean) as Array<{ text: string; polarity: string }>;

  const strengths = (
    Array.isArray(rq.strengths) ? rq.strengths : []
  ).filter((s): s is string => typeof s === "string" && Boolean(s.trim()));
  const weaknesses = (
    Array.isArray(rq.weaknesses) ? rq.weaknesses : []
  ).filter((s): s is string => typeof s === "string" && Boolean(s.trim()));
  const kpiCards = (
    Array.isArray(unified.kpi_cards) ? unified.kpi_cards : []
  )
    .map((k) => {
      const o = asObj(k);
      if (!o || typeof o.label !== "string" || typeof o.value !== "string")
        return null;
      return {
        label: o.label.trim().slice(0, 40),
        value: o.value.trim().slice(0, 48),
        subtext:
          typeof o.subtext === "string" ? o.subtext.trim().slice(0, 80) : "",
      };
    })
    .filter(Boolean) as Array<{
    label: string;
    value: string;
    subtext: string;
  }>;

  const card = asObj(out.card) || {};
  if (mappedHl.length) card.highlights = mappedHl.slice(0, 5);
  if (strengths.length) card.strengths = strengths.slice(0, 4);
  if (weaknesses.length) card.weaknesses = weaknesses.slice(0, 4);
  if (kpiCards.length) card.kpi_cards = kpiCards;
  card.brief = true;

  const rating = String(rq.rating || rq.overall_rating || "").toUpperCase();
  if (rating.startsWith("EXCELLENT")) card.result_quality = "Excellent";
  else if (rating.startsWith("STRONG")) card.result_quality = "Strong";
  else if (rating.startsWith("WEAK")) card.result_quality = "Weak";
  else if (rating.startsWith("AVERAGE") || rating.startsWith("ADEQUATE"))
    card.result_quality = "Average";
  else if (!card.result_quality) card.result_quality = "Average";

  if (cat.includes("bull")) card.mgmt_sentiment = "bullish";
  else if (cat.includes("optimi")) card.mgmt_sentiment = "optimistic";
  else if (cat.includes("caut")) card.mgmt_sentiment = "cautious";
  else if (cat.includes("bear")) card.mgmt_sentiment = "bearish";
  else if (!card.mgmt_sentiment) card.mgmt_sentiment = "neutral";

  if (score10 != null) card.sentiment_score = score10;
  if (typeof sent.tone === "string" && sent.tone.trim()) {
    card.sentiment_tone = sent.tone.trim().slice(0, 120);
  }
  if (typeof sent.conviction === "string" && sent.conviction.trim()) {
    card.conviction = sent.conviction.trim().slice(0, 160);
  }
  if (quotes[0]) card.quote = quotes[0].slice(0, 200);
  if (typeof sent.label === "string" && sent.label.trim()) {
    card.sentiment_label = sent.label.trim();
  }

  out.card = card;
  out.unified_earnings = unified;
  return out;
}

/** @deprecated path kept for scripts that still import the long prompt */
export function loadUnifiedEarningsSystemPrompt(): string {
  return loadScanlinesSystemPrompt();
}
