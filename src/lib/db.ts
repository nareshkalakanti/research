import Database from "better-sqlite3";
import path from "path";
import { researchLinks } from "./links";
import { loadMetricsMap } from "./metrics";

const DATA_DIR = path.join(process.cwd(), "data");

export type CompanyRow = {
  ticker: string;
  name: string;
  market: string;
  website: string | null;
  about: string | null;
  headquarters: string | null;
  sector: string | null;
  sub_sector: string | null;
  price: number | null;
  mcap_cr: number | null;
  search_text: string;
  web: string | null;
  sc: string;
  tv: string;
};

let aboutDb: Database.Database | null = null;
let govDb: Database.Database | null = null;
let classDb: Database.Database | null = null;
let cache: { at: number; rows: CompanyRow[] } | null = null;
const CACHE_MS = 30_000;

function openReadonly(name: string): Database.Database {
  const db = new Database(path.join(DATA_DIR, name), {
    readonly: true,
    fileMustExist: true,
  });
  db.pragma("query_only = ON");
  return db;
}

function getAbout(): Database.Database {
  if (!aboutDb) aboutDb = openReadonly("company_about.db");
  return aboutDb;
}

function getGov(): Database.Database | null {
  if (govDb) return govDb;
  try {
    govDb = openReadonly("governance.db");
    return govDb;
  } catch {
    return null;
  }
}

function getClass(): Database.Database | null {
  if (classDb) return classDb;
  try {
    classDb = openReadonly("classifications.db");
    return classDb;
  } catch {
    return null;
  }
}

type RawAbout = {
  ticker: string;
  name: string | null;
  market: string;
  website: string | null;
  about: string | null;
  yf_about: string | null;
  scraped_about: string | null;
  company_sector: string | null;
  company_industry: string | null;
  headquarters: string | null;
  products: string | null;
  end_markets: string | null;
  theme_tags: string | null;
};

function buildSearchText(
  row: RawAbout,
  about: string | null,
  sector?: string | null,
  sub?: string | null,
): string {
  // HQ first so location themes (e.g. Mumbai) can AND with about terms.
  return [
    row.headquarters,
    row.name,
    row.ticker,
    about,
    row.products,
    row.end_markets,
    sector,
    sub,
    row.headquarters,
  ]
    .filter(Boolean)
    .join(" \n ");
}

function loadGovMap() {
  const govMap = new Map<
    string,
    { sector: string | null; industry: string | null; sub_sector: string | null }
  >();

  const gov = getGov();
  if (gov) {
    const rows = gov
      .prepare(`SELECT ticker, sector, industry, sub_sector FROM companies`)
      .all() as Array<{
      ticker: string;
      sector: string | null;
      industry: string | null;
      sub_sector: string | null;
    }>;
    for (const r of rows) govMap.set(r.ticker, r);
  }

  return govMap;
}

type ClassRow = {
  sector: string | null;
  industry: string | null;
  sub_sector: string | null;
};

/** NSE listing taxonomy (sector / sub_sector) keyed by ticker+market, then ticker. */
function loadClassMaps() {
  const byKey = new Map<string, ClassRow>();
  const byTicker = new Map<string, ClassRow>();
  const db = getClass();
  if (!db) return { byKey, byTicker };

  const rows = db
    .prepare(
      `SELECT ticker, market, sector, industry, sub_sector FROM classifications`,
    )
    .all() as Array<{
    ticker: string;
    market: string;
    sector: string | null;
    industry: string | null;
    sub_sector: string | null;
  }>;

  for (const r of rows) {
    const row: ClassRow = {
      sector: r.sector,
      industry: r.industry,
      sub_sector: r.sub_sector,
    };
    byKey.set(`${r.ticker.toUpperCase()}|${r.market}`, row);
    if (!byTicker.has(r.ticker.toUpperCase())) {
      byTicker.set(r.ticker.toUpperCase(), row);
    }
  }
  return { byKey, byTicker };
}

function pickClass(
  maps: ReturnType<typeof loadClassMaps>,
  ticker: string,
  market: string,
): ClassRow | undefined {
  return (
    maps.byKey.get(`${ticker.toUpperCase()}|${market}`) ||
    maps.byTicker.get(ticker.toUpperCase())
  );
}

function enrichAll(rows: RawAbout[]): CompanyRow[] {
  const govMap = loadGovMap();
  const classMaps = loadClassMaps();
  const metricsMap = loadMetricsMap();

  return rows.map((row) => {
    const cls = pickClass(classMaps, row.ticker, row.market);
    const g = govMap.get(row.ticker);
    const m = metricsMap.get(row.ticker.toUpperCase());

    // Prefer India listing taxonomy (stocks_ai), then Yahoo about, then governance, then YF quote sector.
    const sector =
      nonempty(cls?.sector) ||
      nonempty(row.company_sector) ||
      nonempty(g?.sector) ||
      nonempty(m?.sector) ||
      null;

    const sub_sector =
      nonempty(cls?.sub_sector) ||
      nonempty(cls?.industry) ||
      nonempty(row.company_industry) ||
      nonempty(g?.sub_sector) ||
      nonempty(g?.industry) ||
      null;

    const links = researchLinks(row.ticker, row.market, row.website);
    const about = pickAboutText(row);

    return {
      ticker: row.ticker,
      name: row.name || row.ticker,
      market: row.market,
      website: row.website,
      about,
      headquarters: nonempty(row.headquarters),
      sector,
      sub_sector,
      price: m?.price ?? null,
      mcap_cr: m?.market_cap_cr ?? null,
      search_text: buildSearchText(row, about, sector, sub_sector),
      web: links.web,
      sc: links.sc,
      tv: links.tv,
    };
  });
}

function nonempty(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

/** Nav-scrape / menu dump heuristic (e.g. "About Us Investor Relations Career…"). */
function looksLikeNavJunk(text: string): boolean {
  const t = text.trim();
  if (t.length < 80) return false;
  const navHits = (
    t.match(
      /\b(About Us|Investor Relations|Board of Directors|Corporate Governance|Press and Media|Leadership Team|Our Vision|Policy & Disclosure|Career|CSR)\b/gi,
    ) || []
  ).length;
  if (navHits >= 3) return true;
  // Dense Title-Case tokens without sentence punctuation
  const sentences = (t.match(/[.!?]/g) || []).length;
  const words = t.split(/\s+/).length;
  if (words > 40 && sentences === 0 && navHits >= 2) return true;
  return false;
}

/**
 * Prefer a real company description over scraped website chrome.
 * Order: clean about → yf_about → scraped → raw about.
 */
export function pickAboutText(row: {
  about: string | null;
  yf_about: string | null;
  scraped_about: string | null;
}): string | null {
  const about = nonempty(row.about);
  const yf = nonempty(row.yf_about);
  const scraped = nonempty(row.scraped_about);

  const candidates = [about, scraped, yf].filter(Boolean) as string[];
  const clean = candidates.find((c) => !looksLikeNavJunk(c));
  if (clean) {
    // Prefer Yahoo prose when about/scraped are the same nav dump
    if (yf && !looksLikeNavJunk(yf) && about && looksLikeNavJunk(about)) {
      return yf;
    }
    return clean;
  }
  return yf || about || scraped || null;
}

/** Drop in-memory company cache (call after Yahoo fill). */
export function invalidateCompanyCache(): void {
  cache = null;
}

export function loadAllCompanies(): CompanyRow[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.rows;

  const db = getAbout();
  const rows = db
    .prepare(
      `SELECT ticker, name, market, website, about, yf_about, scraped_about,
              company_sector, company_industry, headquarters,
              products, end_markets, theme_tags
       FROM company_about ORDER BY name COLLATE NOCASE`,
    )
    .all() as RawAbout[];

  const enriched = enrichAll(rows);
  cache = { at: now, rows: enriched };
  return enriched;
}

export function marketCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of loadAllCompanies()) {
    counts[c.market] = (counts[c.market] ?? 0) + 1;
  }
  return counts;
}

export function distinctSectors(): string[] {
  const set = new Set<string>();
  for (const c of loadAllCompanies()) {
    if (c.sector?.trim()) set.add(c.sector.trim());
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
