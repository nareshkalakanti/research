import { loadAllCompanies } from "@/lib/db";
import {
  FUND_WATCHLIST_KEYS,
  fundWatchlistAllTickers,
  loadFundWatchlistStubs,
} from "@/lib/fund-watchlists";
import { researchLinks } from "@/lib/links";
import {
  companyNeedsWebsiteScrape,
  scrapeOutcomeTickerSet,
} from "@/lib/scraper-store";

export type MissingGapKey =
  | "metrics"
  | "price"
  | "mcap"
  | "sector"
  | "sub_sector"
  | "about"
  | "web"
  | "scrape"
  | "scrape_clean"
  | "scrape_empty"
  | "scrape_failed"
  | "scrape_bad"
  | "any";

export type GapFlags = {
  price: boolean;
  mcap: boolean;
  sector: boolean;
  sub_sector: boolean;
  about: boolean;
  web: boolean;
  scrape: boolean;
  scrape_clean: boolean;
  scrape_empty: boolean;
  scrape_failed: boolean;
};

type CompanyLike = {
  ticker: string;
  website?: string | null;
  scraped_about?: string | null;
  scraped_about_clean?: string | null;
  price: number | null;
  mcap_cr: number | null;
  sector: string | null;
  sub_sector: string | null;
  about: string | null;
  web: string | null;
};

/** Optional precomputed scrape outcome sets (avoids N DB lookups). */
export type ScrapeOutcomeSets = {
  empty: Set<string>;
  failed: Set<string>;
};

export function loadScrapeOutcomeSets(market = "All"): ScrapeOutcomeSets {
  return {
    empty: scrapeOutcomeTickerSet(["empty"], market),
    failed: scrapeOutcomeTickerSet(["failed", "blocked"], market),
  };
}

export function companyNeedsScrapeClean(c: {
  scraped_about?: string | null;
  scraped_about_clean?: string | null;
}): boolean {
  return (
    (c.scraped_about ?? "").trim().length >= 80 &&
    !(c.scraped_about_clean ?? "").trim()
  );
}

export function companyGapFlags(
  c: CompanyLike,
  outcomes?: ScrapeOutcomeSets,
): GapFlags {
  const key = c.ticker.toUpperCase();
  const sets = outcomes ?? loadScrapeOutcomeSets("All");
  return {
    price: c.price == null,
    mcap: c.mcap_cr == null,
    sector: !c.sector?.trim(),
    sub_sector: !c.sub_sector?.trim(),
    about: !c.about?.trim(),
    web: !c.web,
    scrape: companyNeedsWebsiteScrape({
      ticker: c.ticker,
      website: c.website ?? null,
      scraped_about: c.scraped_about,
    }),
    scrape_clean: companyNeedsScrapeClean(c),
    scrape_empty: sets.empty.has(key),
    scrape_failed: sets.failed.has(key),
  };
}

export function matchesMissingGap(
  g: GapFlags,
  missing: string,
): boolean {
  const key = missing.trim().toLowerCase();
  if (key === "any") {
    return (
      g.price ||
      g.mcap ||
      g.sector ||
      g.sub_sector ||
      g.about ||
      g.web ||
      g.scrape
    );
  }
  if (key === "price") return g.price;
  if (key === "mcap") return g.mcap;
  if (key === "sector") return g.sector || g.sub_sector;
  if (key === "sub_sector") return g.sub_sector;
  if (key === "about") return g.about;
  if (key === "web") return g.web;
  if (key === "scrape") return g.scrape;
  if (key === "scrape_clean") return g.scrape_clean;
  if (key === "scrape_empty") return g.scrape_empty;
  if (key === "scrape_failed") return g.scrape_failed;
  if (key === "scrape_bad") return g.scrape_empty || g.scrape_failed;
  if (key === "metrics") return g.price || g.mcap;
  return g.price || g.mcap;
}

function fundStubRow(stub: {
  ticker: string;
  name: string;
  market: string;
}) {
  const links = researchLinks(stub.ticker, stub.market, null);
  const name = stub.name?.trim() || stub.ticker;
  return {
    ticker: stub.ticker,
    name,
    market: stub.market,
    website: null,
    about: null,
    scraped_about: null,
    scraped_about_clean: null,
    scrape_source_url: null,
    headquarters: null,
    sector: null,
    sub_sector: null,
    price: null,
    mcap_cr: null,
    search_text: `${stub.ticker} ${name}`.toLowerCase(),
    theme_search_text: `${stub.ticker} ${name}`.toLowerCase(),
    dossier_text: `${name} (${stub.ticker}) · ${stub.market}`,
    web: links.web,
    sc: links.sc,
    tv: links.tv,
  };
}

function appendFundWatchlistStubs(
  companies: ReturnType<typeof loadAllCompanies>,
  tickers: Set<string>,
  all: ReturnType<typeof loadAllCompanies>,
) {
  if (!tickers.size) return companies;
  const byTicker = new Map(all.map((c) => [c.ticker.toUpperCase(), c]));
  const have = new Set(companies.map((c) => c.ticker.toUpperCase()));
  const out = [...companies];
  for (const listKey of FUND_WATCHLIST_KEYS) {
    for (const stub of loadFundWatchlistStubs(listKey, have)) {
      if (!tickers.has(stub.ticker.toUpperCase())) continue;
      out.push(byTicker.get(stub.ticker.toUpperCase()) ?? fundStubRow(stub));
      have.add(stub.ticker.toUpperCase());
    }
  }
  return out;
}

function mergeFundWatchlistUniverse(
  companies: ReturnType<typeof loadAllCompanies>,
  all: ReturnType<typeof loadAllCompanies>,
) {
  const fundAll = fundWatchlistAllTickers();
  if (!fundAll.size) return companies;
  const byTicker = new Map(companies.map((c) => [c.ticker.toUpperCase(), c]));
  for (const c of all) {
    const t = c.ticker.toUpperCase();
    if (fundAll.has(t)) byTicker.set(t, c);
  }
  return appendFundWatchlistStubs([...byTicker.values()], fundAll, all);
}

/** Missing-data tab universe: list + gap filter (matches /api/companies). */
export function loadMissingCompanies(
  market: string,
  missing: string,
): ReturnType<typeof loadAllCompanies> {
  const allCompanies = loadAllCompanies();
  let companies = allCompanies;

  if (market && market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }

  companies = mergeFundWatchlistUniverse(companies, allCompanies);

  const outcomes = loadScrapeOutcomeSets(market || "All");
  return companies
    .filter((c) => matchesMissingGap(companyGapFlags(c, outcomes), missing))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
