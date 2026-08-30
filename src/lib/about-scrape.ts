import { saveScrapedAboutToCompanyAbout, updateCompanyWebsite } from "./company-about-write";
import { scrapeCompanyWebsite } from "./about-scrape-text";
import { hasUsableAboutText, hasUsableYfAbout, loadAllCompanies } from "./db";
import { distillAndSaveScrapedAbout } from "./scrape-clean";
import { websiteUrl } from "./links";
import {
  runConcurrent,
  SCRAPE_BATCH_DEFAULT,
  SCRAPE_BATCH_MAX,
  SCRAPE_CONCURRENCY_DEFAULT,
  SCRAPE_CONCURRENCY_MAX,
  withScrapeWriteLock,
} from "./scrape-pool";
import {
  loadManualAboutMap,
  loadYfAboutMap,
  pendingScrapeCount,
  pendingScrapeTickerSet,
  upsertScrapeResult,
  isWebsiteScrapeStored,
  storedWebsiteScrapeMeta,
  type ScrapeStatus,
} from "./scraper-store";

function maybeFixWebsiteUrl(ticker: string, stored: string | null, foundUrl: string | null): void {
  const storedOrigin = stored ? websiteUrl(stored) : null;
  if (!storedOrigin || !foundUrl) return;
  try {
    const foundOrigin = new URL(foundUrl).origin;
    if (foundOrigin !== new URL(storedOrigin).origin) {
      updateCompanyWebsite(ticker, `${foundOrigin}/`);
    }
  } catch {
    /* ignore */
  }
}

export type AboutScrapeJob = {
  ticker: string;
  name: string;
  market: string;
  website: string | null;
  yf_about: string | null;
};

export type AboutScrapeBatchResult = {
  tried: number;
  saved: number;
  failed: number;
  empty: number;
  remaining: number;
  saved_tickers: string[];
  done: boolean;
};

function hasWebsite(website: string | null | undefined): boolean {
  return !!websiteUrl(website);
}

export function pendingAboutScrapeJobs(opts: {
  market?: string;
  tickers?: string[];
  missingOnly?: boolean;
  /** Scrape even when Yahoo / manual about exists (page scan, theme). */
  despiteYf?: boolean;
  /** Skip tickers with a settled website scrape in DB (default true). */
  skipStored?: boolean;
}): AboutScrapeJob[] {
  const missingOnly = opts.missingOnly !== false;
  const despiteYf = opts.despiteYf === true;
  const skipStored = opts.skipStored !== false;
  const market = opts.market ?? "All";
  let companies = loadAllCompanies().filter((c) => hasWebsite(c.website));

  if (!opts.tickers?.length && market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }
  if (opts.tickers?.length) {
    const set = new Set(opts.tickers.map((t) => t.toUpperCase()));
    companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
  }

  const pendingSet =
    missingOnly && !despiteYf ? pendingScrapeTickerSet(market) : null;
  const yfMap = loadYfAboutMap();
  const manualMap = loadManualAboutMap();

  const jobs: AboutScrapeJob[] = [];
  for (const c of companies) {
    const ticker = c.ticker.toUpperCase();
    const yf_about = yfMap.get(ticker) ?? null;
    const manual_about = manualMap.get(ticker) ?? null;
    if (!despiteYf) {
      if (hasUsableYfAbout({ yf_about })) continue;
      if (hasUsableAboutText(manual_about)) continue;
    }
    if (skipStored && isWebsiteScrapeStored(ticker, c.scraped_about)) continue;
    if (pendingSet && !pendingSet.has(ticker)) continue;
    jobs.push({
      ticker,
      name: c.name || ticker,
      market: c.market,
      website: c.website,
      yf_about,
    });
  }

  jobs.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return jobs;
}

export function pageScrapeSummary(tickers: string[]): {
  total: number;
  with_web: number;
  stored: number;
  eligible: number;
} {
  const set = new Set(tickers.map((t) => t.toUpperCase()));
  let withWeb = 0;
  let stored = 0;
  for (const c of loadAllCompanies()) {
    const key = c.ticker.toUpperCase();
    if (!set.has(key)) continue;
    if (!hasWebsite(c.website)) continue;
    withWeb += 1;
    if (isWebsiteScrapeStored(key, c.scraped_about)) stored += 1;
  }
  return {
    total: tickers.length,
    with_web: withWeb,
    stored,
    eligible: Math.max(0, withWeb - stored),
  };
}

export function pageScrapeEmptyMessage(tickers: string[] | undefined): string {
  if (!tickers?.length) return "Nothing left to scrape for this filter";
  const s = pageScrapeSummary(tickers);
  if (s.with_web === 0) {
    return "No website URLs on this page";
  }
  if (s.eligible === 0) {
    return `All ${s.with_web} companies with websites on this page are already scraped`;
  }
  return "Nothing left to scrape on this page";
}

async function scrapeOne(
  job: AboutScrapeJob,
  opts?: { despiteYf?: boolean },
): Promise<{
  ok: boolean;
  status: ScrapeStatus;
  error: string | null;
  source_url: string | null;
}> {
  if (!opts?.despiteYf && hasUsableYfAbout({ yf_about: job.yf_about })) {
    return {
      ok: false,
      status: "covered",
      error: "Yahoo about already available — website scrape skipped",
      source_url: null,
    };
  }

  const result = await scrapeCompanyWebsite(job.website);
  if (result.text) {
    await withScrapeWriteLock(() => {
      maybeFixWebsiteUrl(job.ticker, job.website, result.url);
      upsertScrapeResult(job.ticker, {
        scraped_about: result.text,
        status: "ok",
        source_url: result.url,
        scrape_source: "website",
      });
      saveScrapedAboutToCompanyAbout(job.ticker, {
        scraped_about: result.text,
        website_status: "ok",
      });
    });
    if (process.env.AUTO_CLEAN_SCRAPE?.trim() === "1") {
      try {
        const company = loadAllCompanies().find(
          (c) => c.ticker.toUpperCase() === job.ticker.toUpperCase(),
        );
        await distillAndSaveScrapedAbout({
          ticker: job.ticker,
          name: job.name,
          sector: company?.sector,
          sub_sector: company?.sub_sector,
          raw_scrape: result.text,
          yf_about: job.yf_about,
          manual_about: company?.about,
        });
      } catch {
        /* LLM clean is best-effort — raw scrape still saved */
      }
    }
    return { ok: true, status: "ok", error: null, source_url: result.url };
  }

  const status: ScrapeStatus =
    result.reason === "no_website"
      ? "blocked"
      : result.reason === "nav_junk"
        ? "failed"
        : "empty";
  const error =
    result.reason === "unreachable"
      ? "Website does not open (timeout / DNS) — check Web URL"
      : result.reason === "nav_junk"
        ? "Page looks like navigation chrome, not company prose"
        : result.reason === "empty_page"
          ? "No usable about text found on site"
          : result.reason === "no_website"
            ? "No website URL"
            : "Fetch failed";

  await withScrapeWriteLock(() => {
    upsertScrapeResult(job.ticker, {
      scraped_about: null,
      status,
      error,
      scrape_source: null,
    });
    saveScrapedAboutToCompanyAbout(job.ticker, {
      scraped_about: null,
      website_status:
        result.reason === "unreachable"
          ? "unreachable"
          : status === "empty"
            ? "not_found"
            : "failed",
    });
  });

  return { ok: false, status, error, source_url: result.url };
}

export type AboutScrapeTickerResult = {
  ok: boolean;
  ticker: string;
  status: ScrapeStatus;
  error: string | null;
  scraped_about: string | null;
  source_url: string | null;
};

export type ScrapeAboutOpts = {
  /** Re-fetch website even when a scrape is already stored in DB. */
  rescan?: boolean;
  /** Scrape website even when Yahoo about exists (theme / Website tab). */
  despiteYf?: boolean;
};

/** Scrape one ticker — skips network when already stored unless rescan. */
export async function scrapeAboutForTicker(
  ticker: string,
  opts?: ScrapeAboutOpts,
): Promise<AboutScrapeTickerResult> {
  const key = ticker.toUpperCase();
  const company = loadAllCompanies().find(
    (c) => c.ticker.toUpperCase() === key,
  );
  if (!company) {
    return {
      ok: false,
      ticker: key,
      status: "failed",
      error: "Company not found",
      scraped_about: null,
      source_url: null,
    };
  }
  if (!hasWebsite(company.website)) {
    return {
      ok: false,
      ticker: key,
      status: "blocked",
      error: "No website URL on file",
      scraped_about: null,
      source_url: null,
    };
  }

  if (
    !opts?.rescan &&
    isWebsiteScrapeStored(key, company.scraped_about)
  ) {
    const stored = storedWebsiteScrapeMeta(key);
    return {
      ok: stored?.status === "ok",
      ticker: key,
      status: stored?.status ?? "ok",
      error: null,
      scraped_about: stored?.scraped_about ?? company.scraped_about,
      source_url: stored?.source_url ?? null,
    };
  }

  const yfMap = loadYfAboutMap();
  const job: AboutScrapeJob = {
    ticker: key,
    name: company.name || key,
    market: company.market,
    website: company.website,
    yf_about: yfMap.get(key) ?? null,
  };
  const result = await scrapeOne(job, {
    despiteYf: opts?.despiteYf ?? true,
  });
  const fresh = loadAllCompanies().find((c) => c.ticker.toUpperCase() === key);
  return {
    ok: result.ok,
    ticker: key,
    status: result.status,
    error: result.error,
    scraped_about: fresh?.scraped_about?.trim() || null,
    source_url: result.source_url,
  };
}

export async function runAboutScrapeBatch(opts: {
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
  despiteYf?: boolean;
  skipStored?: boolean;
  concurrency?: number;
}): Promise<AboutScrapeBatchResult> {
  const limit = Math.min(
    SCRAPE_BATCH_MAX,
    Math.max(1, opts.limit ?? SCRAPE_BATCH_DEFAULT),
  );
  const concurrency = Math.min(
    SCRAPE_CONCURRENCY_MAX,
    Math.max(1, opts.concurrency ?? SCRAPE_CONCURRENCY_DEFAULT),
  );
  const missingOnly = opts.missingOnly !== false;

  const pending = pendingAboutScrapeJobs({
    market: opts.market,
    tickers: opts.tickers,
    missingOnly,
    despiteYf: opts.despiteYf,
    skipStored: opts.skipStored,
  });
  const batch = pending.slice(0, limit);

  const empty: AboutScrapeBatchResult = {
    tried: 0,
    saved: 0,
    failed: 0,
    empty: 0,
    remaining: pending.length,
    saved_tickers: [],
    done: pending.length === 0,
  };
  if (!batch.length) return empty;

  const results = await runConcurrent(batch, concurrency, (job) =>
    scrapeOne(job, { despiteYf: opts.despiteYf }),
  );

  let saved = 0;
  let failed = 0;
  let emptyCount = 0;
  const savedTickers: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i]!;
    const job = batch[i]!;
    if (result.ok) {
      saved += 1;
      savedTickers.push(job.ticker);
    } else if (result.status === "covered") {
      /* Yahoo about covers this ticker */
    } else if (result.status === "empty" || result.status === "blocked") {
      emptyCount += 1;
    } else {
      failed += 1;
    }
  }

  const remaining = Math.max(0, pending.length - batch.length);

  return {
    tried: batch.length,
    saved,
    failed,
    empty: emptyCount,
    remaining,
    saved_tickers: savedTickers,
    done: remaining === 0,
  };
}

export { pendingScrapeCount, websiteScrapeGapCount } from "./scraper-store";
