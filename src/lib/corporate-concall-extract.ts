/**
 * Extract structured fields from concall / earnings-call text.
 * Prefers imported investor_materials transcripts; else Trendlyne SSR (+ Firecrawl PDF).
 * Sentiment = management tone from the call (not price drift).
 */
import { checkLlmStatus, completeJson } from "./llm-client";
import { loadLlmConfig } from "./llm-config";
import type { CorporateExtractPayload } from "./corporate-data";
import { excerptInvestorTextForLlm } from "./investor-material-corpus";
import {
  listInvestorMaterials,
  type InvestorMaterial,
} from "./investor-materials";
import type { TrendlyneConcallHit } from "./trendlyne-investor-discover";

export type ConcallSentimentLabel =
  | "bullish"
  | "optimistic"
  | "neutral"
  | "cautious"
  | "bearish";

export type CorporateConcallExtract = {
  period: string | null;
  url: string | null;
  title: string | null;
  summary: string | null;
  guidance: string | null;
  margins: string | null;
  capex: string | null;
  orders: string | null;
  /** @deprecated prefer sentiment */
  tone: string | null;
  /** Management sentiment from the call transcript */
  sentiment: ConcallSentimentLabel | null;
  /** -2 (bearish) … +2 (bullish) */
  sentiment_score: number | null;
  /** One-line why (growth, margins, guidance cut, etc.) */
  sentiment_why: string | null;
  risks: string | null;
  source: string | null;
};

const CONCALL_SYSTEM = `You are an equity analyst scoring MANAGEMENT SENTIMENT on an Indian company earnings / conference call.
Return ONLY JSON. Use only the transcript — never invent numbers or outlook.
{
  "summary": "2-3 sentences: quarter + headline takeaway with numbers if stated",
  "guidance": "outlook / revenue / volume / margin guidance with numbers if stated, else null",
  "margins": "gross/EBITDA/operating margin commentary with numbers if stated, else null",
  "capex": "capex, capacity, plant, debt if stated, else null",
  "orders": "order book / wins / pipeline if stated, else null",
  "sentiment": "bullish|optimistic|neutral|cautious|bearish",
  "sentiment_score": -2,
  "sentiment_why": "one sentence: what drove the label (guidance raise/cut, demand, margins, order book, risks)",
  "tone": "same as sentiment",
  "risks": "key risks / headwinds management flagged, else null"
}
Sentiment rules (management language, not stock price):
- bullish (+2): confident raise/strong guidance, robust demand, margin expansion clearly stated
- optimistic (+1): constructive / on-track / improving without big caveats
- neutral (0): mixed or factual update, no clear lean
- cautious (-1): soft demand, temporary issues, watchful, delays while still managing
- bearish (-2): cuts, misses, structural pressure, defensive tone
Keep strings under 320 chars (summary under 600). null when not disclosed. No markdown.`;

function clip(s: string | null | undefined, n: number): string | null {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, " ").trim();
  if (!t || /^null$/i.test(t) || /^not disclosed$/i.test(t)) return null;
  return t.slice(0, n);
}

function normalizeSentiment(
  raw: unknown,
): ConcallSentimentLabel | null {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (/bull|very\s*positive|strongly\s*positive/.test(s)) return "bullish";
  if (/optim|positive|constructive|confident/.test(s)) return "optimistic";
  if (/bear|very\s*negative|pessim/.test(s)) return "bearish";
  if (/caut|concern|soft|watchful|defensive|negative/.test(s)) return "cautious";
  if (/neutral|mixed|balanced/.test(s)) return "neutral";
  return null;
}

function scoreForSentiment(s: ConcallSentimentLabel | null): number | null {
  if (!s) return null;
  const map: Record<ConcallSentimentLabel, number> = {
    bullish: 2,
    optimistic: 1,
    neutral: 0,
    cautious: -1,
    bearish: -2,
  };
  return map[s];
}

function clampScore(n: unknown): number | null {
  if (n == null || n === "") return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(-2, Math.min(2, Math.round(x)));
}

function sentimentFromScore(score: number | null): ConcallSentimentLabel | null {
  if (score == null) return null;
  if (score >= 2) return "bullish";
  if (score === 1) return "optimistic";
  if (score === 0) return "neutral";
  if (score === -1) return "cautious";
  return "bearish";
}

/** Lexical management-sentiment score when LLM is offline. */
function heuristicSentiment(body: string): {
  sentiment: ConcallSentimentLabel;
  sentiment_score: number;
  sentiment_why: string;
} {
  const text = body.slice(0, 10_000);
  let score = 0;
  const hits: string[] = [];

  const add = (re: RegExp, delta: number, label: string) => {
    if (re.test(text)) {
      score += delta;
      hits.push(label);
    }
  };

  add(
    /\b(raise[sd]?\s+guidance|upward\s+revision|ahead of (guidance|estimates)|record\s+(revenue|order)|all[- ]time high|strong\s+demand|robust\s+(growth|demand)|margin\s+expansion|confident)\b/i,
    2,
    "raises/strength",
  );
  add(
    /\b(on\s*track|healthy\s+(growth|pipeline)|improving|encouraging|constructive|solid\s+quarter|positive\s+(outlook|order|demand|momentum)|order\s*book.{0,40}(grew|growth|strong))\b/i,
    1,
    "constructive",
  );
  add(
    /\b(temporary|near[- ]term|watchful|cautious|soft(er)?\s+demand|headwind|delay(ed|s)?|challenging|pressure on|cost\s+pressure)\b/i,
    -1,
    "cautions",
  );
  add(
    /\b(cut\s+guidance|lower(ed|ing)\s+guidance|miss(ed)?\s+(guidance|estimates)|weak\s+(demand|quarter)|decline[sd]?\s+sharply|restructuring|impairment)\b/i,
    -2,
    "cuts/weakness",
  );

  score = Math.max(-2, Math.min(2, score > 2 ? 2 : score < -2 ? -2 : score));
  // If both + and - fired, lean toward net
  if (hits.includes("raises/strength") && hits.includes("cuts/weakness")) {
    score = 0;
  } else if (hits.includes("constructive") && hits.includes("cautions") && score === 0) {
    score = -1;
  }

  const sentiment = sentimentFromScore(score) || "neutral";
  const why =
    hits.length > 0
      ? `Heard: ${hits.slice(0, 3).join(", ")}`
      : "No clear bullish/bearish cues — treated as neutral";
  return { sentiment, sentiment_score: score, sentiment_why: why };
}

/** Pull useful sentences when LLM is offline / returns empty. */
function heuristicConcallFacts(text: string): Partial<CorporateConcallExtract> {
  const body = excerptInvestorTextForLlm(text, 14_000);
  const isBoilerplate = (s: string) =>
    /listen-only|opportunity for you to ask|forward[- ]looking statements?|involve (several )?risks and uncertainties|guarantee of future performance|ladies and gentlemen|good day,? and welcome|as a reminder|this conference call may contain|beliefs,? opinion and expectation/i.test(
      s,
    );

  const sentences = body
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length > 50 &&
        s.length < 420 &&
        !isBoilerplate(s) &&
        !/\[… truncated/i.test(s),
    );

  const pick = (re: RegExp, n = 2): string | null => {
    const hits = sentences.filter((s) => re.test(s)).slice(0, n);
    return hits.length ? clip(hits.join(" "), 320) : null;
  };

  const summaryBits = sentences
    .filter((s) =>
      /\b(revenue|sales|ebitda|pat\b|profit|grew|growth of|₹|rs\.?\s*\d|crore|% yoy|% qoq)\b/i.test(
        s,
      ),
    )
    .slice(0, 3);

  const sent = heuristicSentiment(body);

  return {
    summary:
      summaryBits.length > 0
        ? clip(summaryBits.join(" "), 600)
        : clip(
            sentences.find((s) => /\b(quarter|Q[1-4]|FY\s?2)/i.test(s)) ||
              body.replace(/\s+/g, " "),
            500,
          ),
    guidance: pick(
      /\b(guid(ance|e)|outlook|we expect|expect(ed)? (revenue|growth|margin|to)|target(ing|ed)?|maintain(ing)? guidance|fy\s?2[0-9].{0,40}(crore|%|growth))\b/i,
    ),
    margins: pick(
      /\b(ebitda\s*margin|gross\s*margin|operating\s*margin|margin(s)?\s*(at|of|stood|expanded|contracted)|%\s*(ebitda|margin))\b/i,
    ),
    capex: pick(
      /\b(capex|capital\s*expenditure|capacity\s*expansion|commission(ing|ed)|debt\s*(stood|at)|₹\s*\d[\d,.]+\s*cr)/i,
    ),
    orders: pick(
      /\b(order\s*book|order\s*backlog|order\s*win|new\s*orders?|booking(s)?\s*(of|grew)|pipeline)\b/i,
    ),
    risks: pick(
      /\b(challeng|headwind|delay(ed|s)?|competition|raw\s*material|geopolit|disrupt|shortage|pressure on)\b/i,
      1,
    ),
    sentiment: sent.sentiment,
    sentiment_score: sent.sentiment_score,
    sentiment_why: sent.sentiment_why,
    tone: sent.sentiment,
  };
}

function periodSortKey(period: string | null | undefined): number {
  if (!period) return 0;
  const m = period.match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return 0;
  const months: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  return Number(m[2]) * 12 + (months[m[1]!.toLowerCase()] ?? 0);
}

function bestStoredConcall(ticker: string): InvestorMaterial | null {
  const items = listInvestorMaterials(ticker).filter(
    (m) =>
      (m.kind === "concall" || m.kind === "transcript") &&
      ((m.raw_text || "").trim().length > 400 ||
        (m.brief_text || "").trim().length > 200),
  );
  if (!items.length) return null;
  items.sort((a, b) => {
    const pd = periodSortKey(b.period) - periodSortKey(a.period);
    if (pd) return pd;
    return (b.raw_text?.length || 0) - (a.raw_text?.length || 0);
  });
  return items[0] ?? null;
}

async function enrichTextFromPdf(pdfUrl: string | null, current: string): Promise<string> {
  if (!pdfUrl || current.length >= 800) return current;

  // Prefer local Qianfan / Ollama vision when configured
  try {
    const { ocrImageWithQianfan } = await import("./corporate-data-extract");
    // Only if QIANFAN is set — download a few pages via pdf rasterize if possible
    if (process.env.QIANFAN_OCR_BASE_URL?.trim()) {
      const res = await fetch(pdfUrl, {
        signal: AbortSignal.timeout(60_000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const { rasterizePdfPages } = await import("./pdf-rasterize");
        const pages = await rasterizePdfPages(buf, { maxPages: 8, dpi: 144 });
        const parts: string[] = [];
        for (const page of pages) {
          const t = await ocrImageWithQianfan(page.dataUrl);
          if (t.trim()) parts.push(t.trim());
        }
        const joined = parts.join("\n").replace(/\s+/g, " ").trim();
        if (joined.length > current.length) return joined.slice(0, 20_000);
      }
    }
  } catch {
    /* fall through */
  }

  if (process.env.CORPORATE_ALLOW_FIRECRAWL_OCR !== "1") return current;
  try {
    const { firecrawlConfigured, parseDocumentUrl } = await import(
      "./firecrawl-parse"
    );
    if (!firecrawlConfigured()) return current;
    const parsed = await parseDocumentUrl(pdfUrl, {
      maxPages: 16,
      mode: "auto",
      timeoutMs: 120_000,
    });
    const md = parsed.markdown?.replace(/\s+/g, " ").trim() || "";
    return md.length > current.length ? md.slice(0, 20_000) : current;
  } catch {
    return current;
  }
}

function resolveSentimentFields(
  fields: Partial<CorporateConcallExtract>,
  heur: Partial<CorporateConcallExtract>,
): Pick<
  CorporateConcallExtract,
  "sentiment" | "sentiment_score" | "sentiment_why" | "tone"
> {
  const sentiment =
    normalizeSentiment(fields.sentiment) ||
    normalizeSentiment(fields.tone) ||
    normalizeSentiment(heur.sentiment) ||
    normalizeSentiment(heur.tone) ||
    null;
  let score =
    clampScore(fields.sentiment_score) ??
    clampScore(heur.sentiment_score) ??
    scoreForSentiment(sentiment);
  const synced = sentiment || sentimentFromScore(score);
  if (synced && score == null) score = scoreForSentiment(synced);
  return {
    sentiment: synced,
    sentiment_score: score,
    sentiment_why:
      clip(fields.sentiment_why, 280) ||
      clip(heur.sentiment_why, 280) ||
      null,
    tone: synced,
  };
}

async function llmConcallFields(
  text: string,
  meta: { period: string | null; title: string | null },
): Promise<Partial<CorporateConcallExtract>> {
  const cfg = loadLlmConfig();
  const status = await checkLlmStatus(cfg);
  if (!status.available || text.length < 120) return {};

  const excerpt = excerptInvestorTextForLlm(text, 12_000);
  try {
    const parsed = await completeJson(
      cfg,
      CONCALL_SYSTEM,
      `Period: ${meta.period || "unknown"}\nTitle: ${meta.title || ""}\n\nTranscript / filing:\n${excerpt}`,
      { skipStatusCheck: true, temperature: 0, maxTokens: 1400 },
    );
    const sentiment = normalizeSentiment(parsed.sentiment ?? parsed.tone);
    const score =
      clampScore(parsed.sentiment_score) ?? scoreForSentiment(sentiment);
    return {
      summary: clip(parsed.summary != null ? String(parsed.summary) : null, 600),
      guidance: clip(
        parsed.guidance != null ? String(parsed.guidance) : null,
        320,
      ),
      margins: clip(
        parsed.margins != null ? String(parsed.margins) : null,
        320,
      ),
      capex: clip(parsed.capex != null ? String(parsed.capex) : null, 320),
      orders: clip(parsed.orders != null ? String(parsed.orders) : null, 320),
      sentiment,
      sentiment_score: score,
      sentiment_why: clip(
        parsed.sentiment_why != null ? String(parsed.sentiment_why) : null,
        280,
      ),
      tone: sentiment,
      risks: clip(parsed.risks != null ? String(parsed.risks) : null, 320),
    };
  } catch {
    return {};
  }
}

function assemble(
  base: {
    period: string | null;
    url: string | null;
    title: string | null;
    source: string | null;
  },
  fields: Partial<CorporateConcallExtract>,
  heur: Partial<CorporateConcallExtract>,
  fallbackSummary?: string | null,
): CorporateConcallExtract {
  const sent = resolveSentimentFields(fields, heur);
  return {
    period: base.period,
    url: base.url,
    title: base.title,
    summary: fields.summary || heur.summary || fallbackSummary || null,
    guidance: fields.guidance || heur.guidance || null,
    margins: fields.margins || heur.margins || null,
    capex: fields.capex || heur.capex || null,
    orders: fields.orders || heur.orders || null,
    risks: fields.risks || heur.risks || null,
    source: base.source,
    ...sent,
  };
}

/**
 * Build concall extract for a ticker.
 * 1) Local investor_materials transcript (best)
 * 2) Trendlyne listing body + optional Firecrawl PDF
 */
export async function extractCorporateConcall(
  ticker: string,
  trendlyne: TrendlyneConcallHit | null,
): Promise<CorporateConcallExtract | null> {
  const stored = bestStoredConcall(ticker);
  const preferYear = new Date().getFullYear();
  const yearOf = (period: string | null | undefined, label?: string | null) => {
    const a = (period || "").match(/(\d{4})/);
    if (a) return Number(a[1]);
    const b = (label || "").match(/(\d{4})/);
    return b ? Number(b[1]) : 0;
  };
  const storedYear = yearOf(stored?.period);
  const tlYear = yearOf(trendlyne?.period, trendlyne?.date_label);
  const storedKey = periodSortKey(stored?.period);
  const tlKey = periodSortKey(trendlyne?.period);

  // Prefer current-year / newer source. Don't let an old stored transcript
  // block a fresh Trendlyne current-year concall.
  const preferTrendlyne =
    !!trendlyne &&
    (!stored ||
      (tlYear === preferYear && storedYear < preferYear) ||
      tlKey > storedKey);

  if (stored && !preferTrendlyne) {
    const raw = (stored.raw_text || stored.brief_text || "").trim();
    const heur = heuristicConcallFacts(raw);
    const fields = await llmConcallFields(raw, {
      period: stored.period,
      title: stored.title,
    });
    return assemble(
      {
        period: stored.period,
        url: stored.source_url || trendlyne?.url || null,
        title: stored.title || trendlyne?.title || null,
        source: "investor_materials",
      },
      fields,
      heur,
    );
  }

  if (!trendlyne) return null;

  let text = trendlyne.bodyText.replace(/\s+/g, " ").trim();
  text = await enrichTextFromPdf(trendlyne.pdfUrl, text);
  const heur = heuristicConcallFacts(text);
  const fields = await llmConcallFields(text, {
    period: trendlyne.period,
    title: trendlyne.title,
  });

  return assemble(
    {
      period: trendlyne.period,
      url: trendlyne.url,
      title: trendlyne.title,
      source: text.length > 800 ? "trendlyne+pdf" : "trendlyne",
    },
    fields,
    heur,
    clip(text, 500),
  );
}

/** @deprecated use extractCorporateConcall */
export async function extractConcallFromTrendlyne(
  hit: TrendlyneConcallHit,
): Promise<CorporateConcallExtract> {
  return (
    (await extractCorporateConcall("", hit)) || {
      period: hit.period,
      url: hit.url,
      title: hit.title,
      summary: clip(hit.bodyText, 500),
      guidance: null,
      margins: null,
      capex: null,
      orders: null,
      tone: null,
      sentiment: null,
      sentiment_score: null,
      sentiment_why: null,
      risks: null,
      source: "trendlyne",
    }
  );
}

/** Merge concall fields into a corporate extract payload. */
export function mergeConcallIntoExtract(
  extracted: CorporateExtractPayload,
  concall: CorporateConcallExtract | null,
): CorporateExtractPayload {
  if (!concall) return extracted;
  const next: CorporateExtractPayload = {
    ...extracted,
    extras: { ...extracted.extras },
    concall,
  };
  if (concall.summary && !next.extras.earnings_snip) {
    next.extras.earnings_snip = concall.summary;
  }
  if (concall.orders && !next.extras.order_wins) {
    next.extras.order_wins = concall.orders;
  }
  const note = [
    `Concall ${concall.period || ""}`.trim(),
    concall.sentiment ? `sentiment ${concall.sentiment}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  next.notes = [extracted.notes, note].filter(Boolean).join(" · ");
  return next;
}
