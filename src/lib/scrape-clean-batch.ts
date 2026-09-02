import { loadLlmConfig } from "./llm-config";
import { loadAllCompanies, type CompanyRow } from "./db";
import { checkLlmStatus } from "./llm-client";
import { runConcurrent } from "./scrape-pool";
import {
  distillAndSaveScrapedAbout,
  distillScrapedAbout,
  type ScrapeCleanResult,
} from "./scrape-clean";
import { ensureScrapeCleanSchema } from "./scrape-clean-schema";
import { loadYfAboutMap } from "./scraper-store";

export const CLEAN_BATCH_DEFAULT = 12;
export const CLEAN_BATCH_MAX = 16;
export const CLEAN_CONCURRENCY_DEFAULT = 5;
export const CLEAN_CONCURRENCY_MAX = 6;
export const CLEAN_SESSION_MAX_MS = 265_000;
export const CLEAN_SESSION_MAX_ITEMS = 96;

export type ScrapeCleanBatchResult = {
  tried: number;
  saved: number;
  rejected: number;
  failed: number;
  remaining: number;
  saved_tickers: string[];
  done: boolean;
};

export type ScrapeCleanRowProgress = {
  ticker: string;
  batchIndex: number;
  batchSize: number;
  pendingTotal: number;
  result: ScrapeCleanResult | null;
};

type BatchInternalOpts = {
  market?: string;
  tickers?: string[];
  limit?: number;
  force?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  skipLlmCheck?: boolean;
  llmPreChecked?: boolean;
  yfMap?: Map<string, string>;
  onProgress?: (progress: ScrapeCleanRowProgress) => void;
};

function filterMarket(rows: CompanyRow[], market: string): CompanyRow[] {
  if (market === "All") return rows;
  if (market === "NSE") {
    return rows.filter((c) => c.market === "NSE" || c.market === "NSE SME");
  }
  return rows.filter((c) => c.market === market);
}

function filterTickerSet(rows: CompanyRow[], tickers?: string[]): CompanyRow[] {
  if (!tickers?.length) return rows;
  const set = new Set(tickers.map((t) => t.toUpperCase()));
  return rows.filter((c) => set.has(c.ticker.toUpperCase()));
}

export function scrapeCleanCandidates(opts?: {
  market?: string;
  tickers?: string[];
  force?: boolean;
}): CompanyRow[] {
  ensureScrapeCleanSchema();
  let rows = loadAllCompanies().filter(
    (c) => (c.scraped_about || "").trim().length >= 80,
  );
  rows = filterMarket(rows, opts?.market ?? "All");
  rows = filterTickerSet(rows, opts?.tickers);
  if (!opts?.force) {
    rows = rows.filter((c) => !(c.scraped_about_clean || "").trim());
  }
  return rows;
}

export function pendingScrapeCleanCount(market = "All"): number {
  return scrapeCleanCandidates({ market }).length;
}

export function pageScrapeCleanSummary(tickers: string[]): {
  total: number;
  with_raw: number;
  cleaned: number;
  eligible: number;
} {
  const set = new Set(tickers.map((t) => t.toUpperCase()));
  let withRaw = 0;
  let cleaned = 0;
  for (const c of loadAllCompanies()) {
    if (!set.has(c.ticker.toUpperCase())) continue;
    if ((c.scraped_about || "").trim().length >= 80) withRaw += 1;
    if ((c.scraped_about_clean || "").trim().length >= 120) cleaned += 1;
  }
  const eligible = scrapeCleanCandidates({ tickers }).length;
  return { total: set.size, with_raw: withRaw, cleaned, eligible };
}

export function pageScrapeCleanEmptyMessage(tickers: string[] | undefined): string {
  if (!tickers?.length) return "No rows on this page";
  const s = pageScrapeCleanSummary(tickers);
  if (s.eligible === 0) {
    if (s.with_raw === 0) return "No website scrape text on this page";
    return "All scraped rows on this page are already LLM-cleaned";
  }
  return "Nothing left to clean on this page";
}

export async function runScrapeCleanBatch(
  opts: BatchInternalOpts,
): Promise<ScrapeCleanBatchResult> {
  ensureScrapeCleanSchema();

  if (!opts.skipLlmCheck) {
    const cfg = loadLlmConfig();
    const status = await checkLlmStatus(cfg);
    if (!status.available) {
      throw new Error(status.detail || "LLM unavailable");
    }
  }

  const limit = Math.min(
    CLEAN_BATCH_MAX,
    Math.max(1, opts.limit ?? CLEAN_BATCH_DEFAULT),
  );
  const concurrency = Math.min(
    CLEAN_CONCURRENCY_MAX,
    Math.max(1, opts.concurrency ?? CLEAN_CONCURRENCY_DEFAULT),
  );

  const pending = scrapeCleanCandidates({
    market: opts.market,
    tickers: opts.tickers,
    force: opts.force,
  });
  const batch = pending.slice(0, limit);

  const empty: ScrapeCleanBatchResult = {
    tried: 0,
    saved: 0,
    rejected: 0,
    failed: 0,
    remaining: pending.length,
    saved_tickers: [],
    done: pending.length === 0,
  };
  if (!batch.length) return empty;

  const yfMap = opts.yfMap ?? loadYfAboutMap();
  const llmPreChecked = opts.llmPreChecked === true || opts.skipLlmCheck === true;

  const results = await runConcurrent(batch, concurrency, async (c, index) => {
    const raw = c.scraped_about!.trim();
    let result: ScrapeCleanResult | null = null;
    try {
      if (opts.dryRun) {
        result = await distillScrapedAbout({
          ticker: c.ticker,
          name: c.name,
          sector: c.sector,
          sub_sector: c.sub_sector,
          raw_scrape: raw,
          yf_about: yfMap.get(c.ticker.toUpperCase()) ?? null,
          manual_about: c.about,
          llmPreChecked,
        });
      } else {
        result = await distillAndSaveScrapedAbout({
          ticker: c.ticker,
          name: c.name,
          sector: c.sector,
          sub_sector: c.sub_sector,
          raw_scrape: raw,
          yf_about: yfMap.get(c.ticker.toUpperCase()) ?? null,
          manual_about: c.about,
          llmPreChecked,
        });
      }
    } catch {
      result = null;
    }
    opts.onProgress?.({
      ticker: c.ticker,
      batchIndex: index + 1,
      batchSize: batch.length,
      pendingTotal: pending.length,
      result,
    });
    return result;
  });

  let saved = 0;
  let rejected = 0;
  let failed = 0;
  const savedTickers: string[] = [];

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i] as ScrapeCleanResult | null;
    const row = batch[i]!;
    if (!result) {
      failed += 1;
      continue;
    }
    if (result.passed) {
      saved += 1;
      savedTickers.push(row.ticker);
    } else {
      rejected += 1;
    }
  }

  const remaining = Math.max(0, pending.length - batch.length);

  return {
    tried: batch.length,
    saved,
    rejected,
    failed,
    remaining,
    saved_tickers: savedTickers,
    done: remaining === 0,
  };
}

export async function runScrapeCleanSession(opts: {
  market?: string;
  tickers?: string[];
  force?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  batchSize?: number;
  maxMs?: number;
  maxItems?: number;
  onProgress?: (progress: ScrapeCleanRowProgress) => void;
  onBatchDone?: (batch: ScrapeCleanBatchResult) => void;
}): Promise<ScrapeCleanBatchResult> {
  ensureScrapeCleanSchema();

  const cfg = loadLlmConfig();
  const status = await checkLlmStatus(cfg);
  if (!status.available) {
    throw new Error(status.detail || "LLM unavailable");
  }

  const deadline = Date.now() + (opts.maxMs ?? CLEAN_SESSION_MAX_MS);
  const maxItems = opts.maxItems ?? CLEAN_SESSION_MAX_ITEMS;
  const batchSize = Math.min(
    CLEAN_BATCH_MAX,
    opts.batchSize ?? CLEAN_BATCH_DEFAULT,
  );
  const concurrency = Math.min(
    CLEAN_CONCURRENCY_MAX,
    opts.concurrency ?? CLEAN_CONCURRENCY_DEFAULT,
  );
  const yfMap = loadYfAboutMap();

  const agg: ScrapeCleanBatchResult = {
    tried: 0,
    saved: 0,
    rejected: 0,
    failed: 0,
    remaining: scrapeCleanCandidates({
      market: opts.market,
      tickers: opts.tickers,
      force: opts.force,
    }).length,
    saved_tickers: [],
    done: false,
  };

  while (Date.now() < deadline && agg.tried < maxItems) {
    const batch = await runScrapeCleanBatch({
      market: opts.market,
      tickers: opts.tickers,
      limit: batchSize,
      force: opts.force,
      dryRun: opts.dryRun,
      concurrency,
      skipLlmCheck: true,
      llmPreChecked: true,
      yfMap,
      onProgress: opts.onProgress,
    });

    opts.onBatchDone?.(batch);

    if (batch.tried === 0) {
      agg.remaining = batch.remaining;
      agg.done = batch.done;
      break;
    }

    agg.tried += batch.tried;
    agg.saved += batch.saved;
    agg.rejected += batch.rejected;
    agg.failed += batch.failed;
    agg.remaining = batch.remaining;
    agg.done = batch.done;
    if (batch.saved_tickers.length) {
      agg.saved_tickers.push(...batch.saved_tickers);
    }

    if (batch.done) break;
  }

  return agg;
}
