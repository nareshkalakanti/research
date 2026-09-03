import { loadLlmConfig } from "./llm-config";
import { invalidateCompanyCache, looksLikeNavJunk } from "./db";
import { completeJson } from "./llm-client";
import { withScrapeWriteLock } from "./scrape-pool";
import { ensureScrapeCleanSchema } from "./scrape-clean-schema";
import { openSqliteNamed } from "./sqlite-utils";

const CLEAN_SYSTEM = `You distill noisy Indian company website scrape text into factual prose for equity research keyword search.
Return ONLY valid JSON:
{
  "summary": "120-220 words. Plain English sentences about what the company makes/does, products, end markets, business model, exports, therapy areas, manufacturing capabilities. Use industry terms exactly when present in source (CDMO, CRAMS, API, biosimilar, injectables, EPC, etc.).",
  "confidence": "high | low | reject",
  "terms": ["5-12 short domain keywords/phrases from the summary"]
}
Rules:
- Use ONLY facts from Raw website scrape and company context. Do not invent.
- Drop navigation menus, careers, CSR, investor relations boilerplate, cookie banners.
- If source is mostly junk or too thin to describe the business, set confidence to reject and summary to "".
- Do not copy Screener/Yahoo about verbatim if provided — only add website facts not already stated there.
- Prefer concrete nouns over marketing adjectives.`;

export type ScrapeCleanConfidence = "high" | "low" | "reject";

export type ScrapeCleanResult = {
  summary: string | null;
  confidence: ScrapeCleanConfidence;
  terms: string[];
  passed: boolean;
  reason: string;
};

export function passesScrapeCleanGate(
  summary: string,
  confidence: ScrapeCleanConfidence,
): { passed: boolean; reason: string } {
  const text = summary.trim();
  if (confidence === "reject") {
    return { passed: false, reason: "llm_reject" };
  }
  if (text.length < 120) {
    return { passed: false, reason: "too_short" };
  }
  if (looksLikeNavJunk(text)) {
    return { passed: false, reason: "nav_junk" };
  }
  if (confidence === "low" && text.length < 180) {
    return { passed: false, reason: "low_confidence_short" };
  }
  return { passed: true, reason: "ok" };
}

function normalizeConfidence(raw: unknown): ScrapeCleanConfidence {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "high" || v === "low" || v === "reject") return v;
  return "reject";
}

export async function distillScrapedAbout(input: {
  ticker: string;
  name: string;
  sector?: string | null;
  sub_sector?: string | null;
  raw_scrape: string;
  yf_about?: string | null;
  manual_about?: string | null;
  llmPreChecked?: boolean;
}): Promise<ScrapeCleanResult> {
  const raw = input.raw_scrape.trim();
  if (raw.length < 80) {
    return {
      summary: null,
      confidence: "reject",
      terms: [],
      passed: false,
      reason: "raw_too_short",
    };
  }

  const cfg = loadLlmConfig();

  const user = [
    `Ticker: ${input.ticker}`,
    `Name: ${input.name}`,
    input.sector ? `Sector: ${input.sector}` : "",
    input.sub_sector ? `Sub-sector: ${input.sub_sector}` : "",
    input.manual_about?.trim()
      ? `Screener about (context only, do not repeat):\n${input.manual_about.trim().slice(0, 400)}`
      : "",
    input.yf_about?.trim()
      ? `Yahoo about (context only, do not repeat):\n${input.yf_about.trim().slice(0, 400)}`
      : "",
    `Raw website scrape:\n${raw.slice(0, 5000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const parsed = await completeJson(cfg, CLEAN_SYSTEM, user, {
    numPredict: 480,
    temperature: 0.1,
    skipStatusCheck: input.llmPreChecked === true,
  });
  const summary = String(parsed.summary ?? "").trim();
  const confidence = normalizeConfidence(parsed.confidence);
  const terms = Array.isArray(parsed.terms)
    ? parsed.terms
        .map((t) => String(t).trim())
        .filter((t) => t.length >= 2 && t.length <= 80)
        .slice(0, 12)
    : [];
  const gate = passesScrapeCleanGate(summary, confidence);

  return {
    summary: gate.passed ? summary : null,
    confidence,
    terms,
    passed: gate.passed,
    reason: gate.reason,
  };
}

export async function saveScrapedAboutClean(
  ticker: string,
  opts: {
    scraped_about_clean: string | null;
    confidence: ScrapeCleanConfidence;
    skipCacheInvalidate?: boolean;
  },
): Promise<void> {
  ensureScrapeCleanSchema();
  const key = ticker.toUpperCase();
  const text = opts.scraped_about_clean?.trim() || null;
  const now = new Date().toISOString();

  await withScrapeWriteLock(() => {
    const aboutDb = openSqliteNamed("company_about.db", {
      readonly: false,
      wal: true,
    });
    try {
      aboutDb.pragma("busy_timeout = 8000");
      aboutDb
        .prepare(
          `UPDATE company_about SET
             scraped_about_clean = @text,
             has_scraped_about_clean = @has,
             scraped_clean_at = @at
           WHERE ticker = @ticker`,
        )
        .run({
          ticker: key,
          text,
          has: text && text.length >= 120 ? 1 : 0,
          at: now,
        });
    } finally {
      aboutDb.close();
    }

    try {
      const scrapeDb = openSqliteNamed("scraper.db", {
        readonly: false,
        wal: true,
      });
      try {
        scrapeDb.pragma("busy_timeout = 8000");
        scrapeDb
          .prepare(
            `UPDATE company_scrape SET
               scraped_about_clean = @text,
               scraped_clean_at = @at,
               clean_confidence = @confidence,
               updated_at = @at
             WHERE ticker = @ticker`,
          )
          .run({
            ticker: key,
            text,
            at: now,
            confidence: opts.confidence,
          });
      } finally {
        scrapeDb.close();
      }
    } catch {
      /* scraper row may not exist yet */
    }
  });

  if (!opts.skipCacheInvalidate) invalidateCompanyCache();
}

export async function distillAndSaveScrapedAbout(input: {
  ticker: string;
  name: string;
  sector?: string | null;
  sub_sector?: string | null;
  raw_scrape: string;
  yf_about?: string | null;
  manual_about?: string | null;
  llmPreChecked?: boolean;
  skipCacheInvalidate?: boolean;
}): Promise<ScrapeCleanResult> {
  const result = await distillScrapedAbout(input);
  await saveScrapedAboutClean(input.ticker, {
    scraped_about_clean: result.summary,
    confidence: result.confidence,
    skipCacheInvalidate: input.skipCacheInvalidate,
  });
  return result;
}
