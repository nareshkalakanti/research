import { loadAgentConfig } from "./agents/config";
import {
  isPendingInvestorMaterial,
  listInvestorMaterials,
  type InvestorMaterial,
} from "./investor-materials";
import { checkLlmStatus, completeJson } from "./llm-client";

export type CallReviewDirection = "positive" | "negative" | "neutral";

export type CallReviewRow = {
  category: string;
  what_said: string;
  direction: CallReviewDirection;
  thesis_impact: string;
};

export type InvestorCallReview = {
  headline: string;
  rows: CallReviewRow[];
  sources: string;
};

const CATEGORIES = [
  "Guidance & outlook",
  "Segment / geography mix",
  "Margin & cost drivers",
  "Capex & balance sheet",
  "Capital allocation",
  "Management tone",
  "Red flags",
  "Growth catalysts & competitive position",
  "Q&A-only signal",
  "Quarter-over-quarter consistency",
] as const;

const CALL_REVIEW_SYSTEM = `You are an equity analyst reviewing an Indian listed company's earnings call transcript and/or investor presentation.
Extract facts in structured JSON only. Use "Not disclosed" where the document does not cover a point — do not infer numbers or guidance.

Return ONLY valid JSON:
{
  "headline": "≤14 words — the single most important takeaway from these materials for an investor",
  "rows": [
    {
      "category": "Guidance & outlook",
      "what_said": "Factual bullets from source only; use Not disclosed if absent",
      "direction": "positive | negative | neutral",
      "thesis_impact": "One sentence — why this matters for the investment thesis"
    }
  ]
}

You MUST return exactly 10 rows in this order:
1. Guidance & outlook — revenue/volume growth guidance (next quarter + FY) vs prior guidance; margin guidance; order book/pipeline
2. Segment / geography mix — revenue/margin by segment; fastest/weakest; new capacity tied to segment
3. Margin & cost drivers — raw material % of sales; operating leverage; one-offs this quarter
4. Capex & balance sheet — capex spent vs planned and funding; net debt/EBITDA; working capital days
5. Capital allocation — dividend/buyback/bonus; M&A/JV/stake-sale intent
6. Management tone — hedged vs committed language; tone shift vs prior quarter; deflected questions
7. Red flags — auditor change, RPT, promoter pledge; client concentration; regulatory/legal; silent guidance restatement
8. Growth catalysts & competitive position — new capacity/product/export with timeline; market share; industry tailwind/headwind
9. Q&A-only signal — repeated analyst concerns; numbers disclosed only in Q&A
10. Quarter-over-quarter consistency — compare to prior concall guidance; flag walked-back or upgraded statements

Rules:
- direction must be exactly positive, negative, or neutral
- what_said: concise factual bullets separated by · ; no invented ₹ or dates
- If prior concall is provided, use it only for row 10 and tone comparisons
- Do not repeat these instructions in output`;

type CacheEntry = { at: number; hash: string; review: InvestorCallReview | null };
const cache = new Map<string, CacheEntry>();
const CACHE_MS = 60 * 60 * 1000;

function normalizeDirection(raw: unknown): CallReviewDirection {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s.startsWith("pos")) return "positive";
  if (s.startsWith("neg")) return "negative";
  return "neutral";
}

function normalizeRow(raw: Record<string, unknown>, fallbackCategory: string): CallReviewRow {
  return {
    category: String(raw.category || fallbackCategory).slice(0, 80),
    what_said: String(raw.what_said || "Not disclosed").slice(0, 900),
    direction: normalizeDirection(raw.direction),
    thesis_impact: String(raw.thesis_impact || "").slice(0, 320) || "Limited impact on thesis from disclosed materials.",
  };
}

function sourceLabel(m: InvestorMaterial): string {
  const kind = m.kind === "ppt" ? "PPT" : m.kind === "concall" ? "concall" : m.kind;
  return m.period ? `${m.period} ${kind}` : kind;
}

function buildCallReviewCorpus(ticker: string): {
  corpus: string;
  hash: string;
  sources: string;
} | null {
  const items = listInvestorMaterials(ticker).filter((m) => !isPendingInvestorMaterial(m));
  const concalls = items.filter((m) => m.kind === "concall" && m.raw_text.replace(/\s/g, "").length >= 80);
  const ppts = items.filter((m) => m.kind === "ppt" && m.raw_text.replace(/\s/g, "").length >= 80);

  const latestConcall = concalls[0];
  const priorConcall = concalls[1];
  const latestPpt = ppts[0];

  if (!latestConcall && !latestPpt) return null;

  const parts: string[] = [];
  const sourceParts: string[] = [];

  if (latestConcall) {
    parts.push(
      `=== LATEST CONCALL (${latestConcall.period || "undated"}) ===\n${latestConcall.raw_text.slice(0, 20_000)}`,
    );
    sourceParts.push(sourceLabel(latestConcall));
  }
  if (latestPpt) {
    parts.push(
      `=== LATEST INVESTOR PPT (${latestPpt.period || "undated"}) ===\n${latestPpt.raw_text.slice(0, 20_000)}`,
    );
    sourceParts.push(sourceLabel(latestPpt));
  }
  if (priorConcall) {
    parts.push(
      `=== PRIOR CONCALL (${priorConcall.period || "undated"}) — for QoQ comparison ===\n${priorConcall.raw_text.slice(0, 10_000)}`,
    );
  }

  const corpus = parts.join("\n\n");
  if (corpus.replace(/\s/g, "").length < 80) return null;

  const hash = [
    latestConcall?.updated_at,
    latestPpt?.updated_at,
    priorConcall?.updated_at,
    corpus.length,
  ].join("|");

  return { corpus, hash, sources: sourceParts.join(" · ") };
}

function normalizeReview(raw: Record<string, unknown>, sources: string): InvestorCallReview {
  const headline = String(raw.headline || "Call review unavailable").slice(0, 140);
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
  const rows: CallReviewRow[] = CATEGORIES.map((category, i) => {
    const row = rawRows[i];
    if (row && typeof row === "object") {
      return normalizeRow(row as Record<string, unknown>, category);
    }
    return {
      category,
      what_said: "Not disclosed",
      direction: "neutral",
      thesis_impact: "Insufficient detail in available materials.",
    };
  });

  return { headline, rows, sources };
}

/** Structured equity review from latest concall + PPT in Calls tab. */
export async function generateInvestorCallReview(
  ticker: string,
): Promise<InvestorCallReview | null> {
  const key = ticker.toUpperCase();
  const built = buildCallReviewCorpus(key);
  if (!built) return null;

  const hit = cache.get(key);
  if (hit && hit.hash === built.hash && Date.now() - hit.at < CACHE_MS) {
    return hit.review;
  }

  const cfg = loadAgentConfig();
  const llm = await checkLlmStatus(cfg);
  if (!llm.available) return null;

  try {
    const parsed = await Promise.race([
      completeJson(
        cfg,
        CALL_REVIEW_SYSTEM,
        `Company: ${key}\nSources: ${built.sources}\n\n${built.corpus.slice(0, 45_000)}`,
        { numPredict: 2200, temperature: 0.1 },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("call review timeout")), 75_000),
      ),
    ]);
    const review = normalizeReview(parsed, built.sources);
    cache.set(key, { at: Date.now(), hash: built.hash, review });
    return review;
  } catch {
    cache.set(key, { at: Date.now(), hash: built.hash, review: null });
    return null;
  }
}

export { CATEGORIES };
