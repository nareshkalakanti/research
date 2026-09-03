import { loadLlmConfig } from "./llm-config";
import { invalidateCompanyCache, loadAllCompanies, type CompanyRow } from "./db";
import { checkLlmStatus } from "./llm-client";
import { runConcurrent } from "./scrape-pool";
import {
  distillAndSaveScrapedAbout,
  distillScrapedAbout,
  type ScrapeCleanResult,
} from "./scrape-clean";
import { ensureScrapeCleanSchema } from "./scrape-clean-schema";
import { loadYfAboutMap } from "./scraper-store";
import { openSqliteNamed } from "./sqlite-utils";

export const CLEAN_BATCH_DEFAULT = 12;
export const CLEAN_BATCH_MAX = 16;
export const CLEAN_CONCURRENCY_DEFAULT = 5;
export const CLEAN_CONCURRENCY_MAX = 6;
export const CLEAN_CLI_CONCURRENCY_DEFAULT = 8;
export const CLEAN_CLI_CONCURRENCY_MAX = 16;
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

export type ScrapeCleanWorkRow = {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  sub_sector: string | null;
  about: string | null;
  scraped_about: string;
};

export type ScrapeCleanInventory = {
  withRaw: number;
  alreadyClean: number;
  alreadyAttempted: number;
  pending: ScrapeCleanWorkRow[];
};

type BatchInternalOpts = {
  market?: string;
  tickers?: string[];
  limit?: number;
  force?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  capLimit?: boolean;
  skipLlmCheck?: boolean;
  llmPreChecked?: boolean;
  skipCacheInvalidate?: boolean;
  yfMap?: Map<string, string>;
  onProgress?: (progress: ScrapeCleanRowProgress) => void;
};

type AboutCleanRow = {
  ticker: string;
  name: string | null;
  market: string | null;
  about: string | null;
  company_sector: string | null;
  company_industry: string | null;
  scraped_about: string | null;
  scraped_about_clean: string | null;
  scraped_clean_at: string | null;
};

function hasText(v: string | null | undefined): boolean {
  return Boolean((v ?? "").trim());
}

function marketSql(market: string): { sql: string; params: string[] } {
  if (!market || market === "All") return { sql: "", params: [] };
  if (market === "NSE") {
    return { sql: ` AND market IN ('NSE', 'NSE SME')`, params: [] };
  }
  return { sql: ` AND market = ?`, params: [market] };
}

function toWorkRow(r: AboutCleanRow): ScrapeCleanWorkRow {
  const ticker = r.ticker.toUpperCase();
  return {
    ticker,
    name: r.name?.trim() || ticker,
    market: (r.market || "NSE").trim() || "NSE",
    sector: r.company_sector?.trim() || null,
    sub_sector: r.company_industry?.trim() || null,
    about: r.about?.trim() || null,
    scraped_about: (r.scraped_about || "").trim(),
  };
}

export function loadScrapeCleanInventory(opts?: {
  market?: string;
  tickers?: string[];
  force?: boolean;
}): ScrapeCleanInventory {
  ensureScrapeCleanSchema();
  const market = opts?.market ?? "All";
  const { sql: marketClause, params } = marketSql(market);
  const tickerSet = opts?.tickers?.length
    ? new Set(opts.tickers.map((t) => t.toUpperCase()))
    : null;

  const db = openSqliteNamed("company_about.db", {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows = db
      .prepare(
        `SELECT ticker, name, market, about, company_sector, company_industry,
                scraped_about, scraped_about_clean, scraped_clean_at
         FROM company_about
         WHERE LENGTH(TRIM(COALESCE(scraped_about, ''))) >= 80
         ${marketClause}
         ORDER BY ticker COLLATE NOCASE`,
      )
      .all(...params) as AboutCleanRow[];

    const pending: ScrapeCleanWorkRow[] = [];
    let alreadyClean = 0;
    let alreadyAttempted = 0;
    let withRaw = 0;

    for (const r of rows) {
      const ticker = (r.ticker || "").toUpperCase();
      if (!ticker) continue;
      if (tickerSet && !tickerSet.has(ticker)) continue;
      withRaw += 1;
      const clean = hasText(r.scraped_about_clean);
      const attempted = hasText(r.scraped_clean_at);
      if (opts?.force) {
        pending.push(toWorkRow(r));
        if (clean) alreadyClean += 1;
        else if (attempted) alreadyAttempted += 1;
        continue;
      }
      if (clean) {
        alreadyClean += 1;
        continue;
      }
      if (attempted) {
        alreadyAttempted += 1;
        continue;
      }
      pending.push(toWorkRow(r));
    }

    return { withRaw, alreadyClean, alreadyAttempted, pending };
  } finally {
    db.close();
  }
}

export function scrapeCleanCandidates(opts?: {
  market?: string;
  tickers?: string[];
  force?: boolean;
}): CompanyRow[] {
  const inv = loadScrapeCleanInventory(opts);
  const want = new Set(inv.pending.map((r) => r.ticker));
  if (!want.size) return [];
  return loadAllCompanies().filter((c) => want.has(c.ticker.toUpperCase()));
}

export function pendingScrapeCleanCount(market = "All"): number {
  return loadScrapeCleanInventory({ market }).pending.length;
}

let attemptedCache: { at: number; set: Set<string> } | null = null;
const ATTEMPTED_CACHE_MS = 15_000;

export function scrapeCleanAttemptedSet(): Set<string> {
  const now = Date.now();
  if (attemptedCache && now - attemptedCache.at < ATTEMPTED_CACHE_MS) {
    return attemptedCache.set;
  }
  ensureScrapeCleanSchema();
  const set = new Set<string>();
  try {
    const db = openSqliteNamed("company_about.db", {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = db
        .prepare(
          `SELECT UPPER(ticker) AS ticker
           FROM company_about
           WHERE TRIM(COALESCE(scraped_about_clean, '')) = ''
             AND TRIM(COALESCE(scraped_clean_at, '')) != ''`,
        )
        .all() as Array<{ ticker: string }>;
      for (const r of rows) if (r.ticker) set.add(r.ticker);
    } finally {
      db.close();
    }
  } catch {
    /* missing db */
  }
  attemptedCache = { at: now, set };
  return set;
}

export function invalidateScrapeCleanAttemptedCache(): void {
  attemptedCache = null;
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
  const eligible = loadScrapeCleanInventory({ tickers }).pending.length;
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

async function cleanWorkRows(
  batch: ScrapeCleanWorkRow[],
  pendingTotal: number,
  opts: BatchInternalOpts,
): Promise<ScrapeCleanBatchResult> {
  const concurrency = Math.max(1, opts.concurrency ?? CLEAN_CONCURRENCY_DEFAULT);
  const yfMap = opts.yfMap ?? loadYfAboutMap();
  const llmPreChecked = opts.llmPreChecked === true || opts.skipLlmCheck === true;
  const skipCacheInvalidate = opts.skipCacheInvalidate === true;

  const results = await runConcurrent(batch, concurrency, async (c, index) => {
    const raw = c.scraped_about;
    let result: ScrapeCleanResult | null = null;
    try {
      const payload = {
        ticker: c.ticker,
        name: c.name,
        sector: c.sector,
        sub_sector: c.sub_sector,
        raw_scrape: raw,
        yf_about: yfMap.get(c.ticker.toUpperCase()) ?? null,
        manual_about: c.about,
        llmPreChecked,
        skipCacheInvalidate,
      };
      result = opts.dryRun
        ? await distillScrapedAbout(payload)
        : await distillAndSaveScrapedAbout(payload);
    } catch {
      result = null;
    }
    opts.onProgress?.({
      ticker: c.ticker,
      batchIndex: index + 1,
      batchSize: batch.length,
      pendingTotal,
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

  const remaining = Math.max(0, pendingTotal - batch.length);
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

  const requested = Math.max(1, opts.limit ?? CLEAN_BATCH_DEFAULT);
  const limit =
    opts.capLimit === false ? requested : Math.min(CLEAN_BATCH_MAX, requested);
  const concurrency = Math.min(
    opts.capLimit === false ? CLEAN_CLI_CONCURRENCY_MAX : CLEAN_CONCURRENCY_MAX,
    Math.max(1, opts.concurrency ?? CLEAN_CONCURRENCY_DEFAULT),
  );

  const inv = loadScrapeCleanInventory({
    market: opts.market,
    tickers: opts.tickers,
    force: opts.force,
  });
  const batch = inv.pending.slice(0, limit);

  if (!batch.length) {
    return {
      tried: 0,
      saved: 0,
      rejected: 0,
      failed: 0,
      remaining: 0,
      saved_tickers: [],
      done: true,
    };
  }

  return cleanWorkRows(batch, inv.pending.length, {
    ...opts,
    concurrency,
  });
}

/** CLI path: skip done rows, process all pending in one parallel pool. */
export async function runScrapeCleanQueue(opts: {
  market?: string;
  tickers?: string[];
  limit?: number;
  force?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  onProgress?: (progress: ScrapeCleanRowProgress) => void;
}): Promise<ScrapeCleanBatchResult & ScrapeCleanInventory> {
  ensureScrapeCleanSchema();

  const cfg = loadLlmConfig();
  const status = await checkLlmStatus(cfg);
  if (!status.available) {
    throw new Error(status.detail || "LLM unavailable");
  }

  const inv = loadScrapeCleanInventory({
    market: opts.market,
    tickers: opts.tickers,
    force: opts.force,
  });
  const batch =
    opts.limit && opts.limit > 0
      ? inv.pending.slice(0, opts.limit)
      : inv.pending;
  const concurrency = Math.min(
    CLEAN_CLI_CONCURRENCY_MAX,
    Math.max(1, opts.concurrency ?? CLEAN_CLI_CONCURRENCY_DEFAULT),
  );

  if (!batch.length) {
    return {
      ...inv,
      tried: 0,
      saved: 0,
      rejected: 0,
      failed: 0,
      remaining: 0,
      saved_tickers: [],
      done: true,
    };
  }

  const yfMap = loadYfAboutMap();
  const result = await cleanWorkRows(batch, inv.pending.length, {
    dryRun: opts.dryRun,
    concurrency,
    llmPreChecked: true,
    skipLlmCheck: true,
    skipCacheInvalidate: true,
    yfMap,
    onProgress: opts.onProgress,
  });

  invalidateCompanyCache();
  invalidateScrapeCleanAttemptedCache();
  return { ...inv, ...result };
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
  return runScrapeCleanQueue({
    market: opts.market,
    tickers: opts.tickers,
    force: opts.force,
    dryRun: opts.dryRun,
    concurrency: opts.concurrency,
    limit: opts.maxItems,
    onProgress: opts.onProgress,
  });
}
