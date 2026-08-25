/**
 * Theme-driven website scrape — sector-gated companies missing scrape text.
 */
import { scrapeAboutForTicker } from "./about-scrape";
import type { CompanyRow } from "./db";
import { loadAllCompanies } from "./db";
import { websiteUrl } from "./links";
import { runConcurrent, SCRAPE_CONCURRENCY_DEFAULT } from "./scrape-pool";
import { isWebsiteScrapeStored } from "./scraper-store";
import { loadThemeSectorFilters, sectorGatePasses } from "./theme-match";
import type { Theme } from "./themes";

export type ThemeScrapeStats = {
  tried: number;
  saved: number;
  failed: number;
  empty: number;
  remaining: number;
  sector_pool: number;
  saved_tickers: string[];
};

/** Sector-gated issuers with a website but no stored scrape yet. */
export function themeScrapeCandidates(
  companies: CompanyRow[],
  themes: Theme[],
): CompanyRow[] {
  if (!themes.length) return [];
  const filters = loadThemeSectorFilters();
  const out: CompanyRow[] = [];
  for (const c of companies) {
    if (!websiteUrl(c.website)) continue;
    if (isWebsiteScrapeStored(c.ticker, c.scraped_about)) continue;
    const gated = themes.some((t) => sectorGatePasses(c, filters[t.id]));
    if (!gated) continue;
    out.push(c);
  }
  out.sort((a, b) =>
    (a.name || a.ticker).localeCompare(b.name || b.ticker, undefined, {
      sensitivity: "base",
    }),
  );
  return out;
}

export function countThemeScrapeCandidates(
  companies: CompanyRow[],
  themes: Theme[],
): number {
  return themeScrapeCandidates(companies, themes).length;
}

/** Scrape the next batch of sector-gated companies for active themes. */
export async function runThemeScrapeBatch(opts: {
  companies: CompanyRow[];
  themes: Theme[];
  limit?: number;
}): Promise<ThemeScrapeStats> {
  const limit = Math.min(15, Math.max(1, opts.limit ?? 5));
  const candidates = themeScrapeCandidates(opts.companies, opts.themes);
  const batch = candidates.slice(0, limit);

  if (!batch.length) {
    return {
      tried: 0,
      saved: 0,
      failed: 0,
      empty: 0,
      remaining: 0,
      sector_pool: candidates.length,
      saved_tickers: [],
    };
  }

  let saved = 0;
  let failed = 0;
  let empty = 0;
  const savedTickers: string[] = [];

  const results = await runConcurrent(
    batch,
    Math.min(4, SCRAPE_CONCURRENCY_DEFAULT),
    (c) =>
      scrapeAboutForTicker(c.ticker, {
        despiteYf: true,
        rescan: false,
      }),
  );

  for (const result of results) {
    if (result.ok) {
      saved += 1;
      savedTickers.push(result.ticker);
    } else if (
      result.status === "empty" ||
      result.status === "blocked" ||
      result.status === "failed"
    ) {
      if (result.status === "failed") failed += 1;
      else empty += 1;
    }
  }

  const fresh = loadAllCompanies();
  const pool = new Set(opts.companies.map((c) => c.ticker.toUpperCase()));
  const remaining = themeScrapeCandidates(
    fresh.filter((c) => pool.has(c.ticker.toUpperCase())),
    opts.themes,
  ).length;

  return {
    tried: batch.length,
    saved,
    failed,
    empty,
    remaining,
    sector_pool: candidates.length,
    saved_tickers: savedTickers,
  };
}
