import { loadLlmConfig } from "./llm-config";
import { buildCallReviewCorpus } from "./investor-material-corpus";
import { checkLlmStatus, completeJson } from "./llm-client";
import { loadPrompt } from "./prompts";

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

const CALL_REVIEW_FALLBACK = `You are an equity analyst reviewing concall/PPT materials. Return ONLY valid JSON with headline and 10 rows (Guidance, Segment mix, Margins, Capex, Capital allocation, Tone, Red flags, Growth catalysts, Q&A signal, QoQ consistency). Use "Not disclosed" when absent.`;

function callReviewSystemPrompt(): string {
  return loadPrompt("investor-call-review", CALL_REVIEW_FALLBACK);
}

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

  const cfg = loadLlmConfig();
  const llm = await checkLlmStatus(cfg);
  if (!llm.available) return null;

  try {
    const parsed = await Promise.race([
      completeJson(
        cfg,
        callReviewSystemPrompt(),
        `Company: ${key}\nSources: ${built.sources}\n\n${built.corpus.slice(0, 45_000)}`,
        { numPredict: 2200, temperature: 0.1 },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("call review timeout")), 45_000),
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
