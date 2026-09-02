import { loadAgentConfig } from "./agents/config";
import {
  hasUsableAboutText,
  invalidateCompanyCache,
  loadAllCompanies,
  type CompanyRow,
} from "./db";
import { completeJson, checkLlmStatus } from "./llm-client";
import { ensureLlmAboutSchema } from "./llm-about-schema";
import { loadPrompt } from "./prompts";
import { runConcurrent } from "./scrape-pool";
import { openSqliteNamed } from "./sqlite-utils";

const ABOUT_FALLBACK = `Return ONLY JSON: {"about":"","confidence":"reject"}`;

function normalizeConfidence(raw: unknown): "high" | "low" | "reject" {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "high" || v === "low" || v === "reject") return v;
  return "reject";
}

export function companyNeedsLlmAbout(c: {
  about?: string | null;
  llm_about?: string | null;
}): boolean {
  if (hasUsableAboutText(c.about)) return false;
  return !hasUsableAboutText(c.llm_about);
}

export function saveLlmAbout(
  ticker: string,
  about: string | null,
): void {
  ensureLlmAboutSchema();
  const key = ticker.toUpperCase();
  const text = about?.trim() || null;
  const now = new Date().toISOString();
  const db = openSqliteNamed("company_about.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `UPDATE company_about SET
         llm_about = @text,
         has_llm_about = @has,
         llm_about_at = @at
       WHERE ticker = @ticker`,
    ).run({
      ticker: key,
      text,
      has: text && text.length >= 40 ? 1 : 0,
      at: text ? now : null,
    });
  } finally {
    db.close();
  }
  invalidateCompanyCache();
}

export async function generateLlmAbout(input: {
  ticker: string;
  name: string;
  market: string;
  sector?: string | null;
  sub_sector?: string | null;
  about?: string | null;
  yf_about?: string | null;
  products?: string | null;
  end_markets?: string | null;
  llmPreChecked?: boolean;
}): Promise<{ about: string | null; confidence: "high" | "low" | "reject" }> {
  const cfg = loadAgentConfig();
  const user = [
    `Ticker: ${input.ticker}`,
    `Name: ${input.name}`,
    `Market: ${input.market}`,
    input.sector ? `Listed sector: ${input.sector}` : "",
    input.sub_sector ? `Sub-sector: ${input.sub_sector}` : "",
    input.products?.trim() ? `Products: ${input.products.trim().slice(0, 400)}` : "",
    input.end_markets?.trim()
      ? `End markets: ${input.end_markets.trim().slice(0, 400)}`
      : "",
    input.about?.trim()
      ? `Screener/Yahoo about:\n${input.about.trim().slice(0, 900)}`
      : "",
    input.yf_about?.trim() &&
    input.yf_about.trim() !== (input.about ?? "").trim()
      ? `Yahoo about:\n${input.yf_about.trim().slice(0, 900)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const parsed = await completeJson(
    cfg,
    loadPrompt("llm-about", ABOUT_FALLBACK),
    user,
    {
      numPredict: 420,
      maxTokens: 420,
      temperature: 0.1,
      skipStatusCheck: input.llmPreChecked === true,
    },
  );
  const confidence = normalizeConfidence(parsed.confidence);
  const about = String(parsed.about ?? "").trim().replace(/\s+/g, " ");
  if (confidence === "reject" || about.length < 40) {
    return { about: null, confidence };
  }
  return { about: about.slice(0, 1200), confidence };
}

export type LlmAboutFillResult = {
  tried: number;
  saved: number;
  failed: number;
  remaining: number;
  saved_tickers: string[];
};

function filterMarket(rows: CompanyRow[], market: string): CompanyRow[] {
  if (market === "All") return rows;
  if (market === "NSE") {
    return rows.filter((c) => c.market === "NSE" || c.market === "NSE SME");
  }
  return rows.filter((c) => c.market === market);
}

export function llmAboutCandidates(opts?: {
  market?: string;
  tickers?: string[];
}): CompanyRow[] {
  ensureLlmAboutSchema();
  let rows = loadAllCompanies().filter((c) => companyNeedsLlmAbout(c));
  rows = filterMarket(rows, opts?.market ?? "All");
  if (opts?.tickers?.length) {
    const set = new Set(opts.tickers.map((t) => t.toUpperCase()));
    rows = rows.filter((c) => set.has(c.ticker.toUpperCase()));
  }
  rows.sort((a, b) => {
    const sme =
      Number(b.market.includes("SME")) - Number(a.market.includes("SME"));
    if (sme) return sme;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

export async function fillLlmAboutBatch(opts?: {
  market?: string;
  tickers?: string[];
  limit?: number;
  concurrency?: number;
}): Promise<LlmAboutFillResult> {
  const limit = Math.min(20, Math.max(1, opts?.limit ?? 8));
  const concurrency = Math.min(3, Math.max(1, opts?.concurrency ?? 2));
  const pending = llmAboutCandidates({
    market: opts?.market,
    tickers: opts?.tickers,
  }).slice(0, limit);

  if (!pending.length) {
    return { tried: 0, saved: 0, failed: 0, remaining: 0, saved_tickers: [] };
  }

  const cfg = loadAgentConfig();
  const status = await checkLlmStatus(cfg);
  if (!status.available) {
    throw new Error(status.hint || status.detail || "LLM unavailable");
  }

  const saved_tickers: string[] = [];
  let failed = 0;
  await runConcurrent(pending, concurrency, async (c) => {
    try {
      const result = await generateLlmAbout({
        ticker: c.ticker,
        name: c.name,
        market: c.market,
        sector: c.sector,
        sub_sector: c.sub_sector,
        about: c.about,
        llmPreChecked: true,
      });
      if (result.about) {
        saveLlmAbout(c.ticker, result.about);
        saved_tickers.push(c.ticker);
      } else {
        failed += 1;
      }
    } catch (err) {
      failed += 1;
      console.warn(
        "[llm-about]",
        c.ticker,
        err instanceof Error ? err.message : err,
      );
    }
  });

  const remaining = llmAboutCandidates({
    market: opts?.market,
    tickers: opts?.tickers,
  }).length;

  return {
    tried: pending.length,
    saved: saved_tickers.length,
    failed,
    remaining,
    saved_tickers,
  };
}
