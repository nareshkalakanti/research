import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { researchLinks } from "./links";
import { loadMetricsMap } from "./metrics";
import { ensureScrapeCleanSchema } from "./scrape-clean-schema";
import { ensureInvestorMaterialsSchema } from "./investor-materials-schema";
import { ensureLlmAboutSchema } from "./llm-about-schema";
import { ensureWebProfileSchema } from "./web-profile-schema";
import { openSqliteNamed } from "./sqlite-utils";

const DATA_DIR = path.join(process.cwd(), "data");

export type CompanyRow = {
  ticker: string;
  name: string;
  market: string;
  website: string | null;
  about: string | null;
  scraped_about: string | null;
  scraped_about_clean: string | null;
  llm_about: string | null;
  scrape_source_url: string | null;
  headquarters: string | null;
  ceo: string | null;
  managing_director: string | null;
  founded_year: string | null;
  sector: string | null;
  sub_sector: string | null;
  price: number | null;
  mcap_cr: number | null;
  search_text: string;
  /** About + Yahoo only — used by Theme Scanner (no website scrape). */
  theme_search_text: string;
  /** Same sources as theme_search_text + optional cleaned website summary for LLM briefs. */
  dossier_text: string;
  web: string | null;
  sc: string;
  tv: string;
};

let aboutDb: Database.Database | null = null;
let govDb: Database.Database | null = null;
let classDb: Database.Database | null = null;
let cache: { at: number; rows: CompanyRow[] } | null = null;
const CACHE_MS = 30_000;
let scrapeSourceCache: Map<string, string> | null = null;

function loadScrapeSourceMap(): Map<string, string> {
  if (scrapeSourceCache) return scrapeSourceCache;
  scrapeSourceCache = new Map();
  const scrapePath = path.join(DATA_DIR, "scraper.db");
  if (!fs.existsSync(scrapePath)) return scrapeSourceCache;
  let db: Database.Database | null = null;
  try {
    db = openSqliteNamed("scraper.db", { readonly: true, fileMustExist: true });
    const cols = db.prepare(`PRAGMA table_info(company_scrape)`).all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "source_url")) return scrapeSourceCache;
    for (const r of db
      .prepare(
        `SELECT ticker, source_url FROM company_scrape
         WHERE TRIM(COALESCE(source_url, '')) != ''`,
      )
      .all() as Array<{ ticker: string; source_url: string }>) {
      scrapeSourceCache.set(r.ticker.toUpperCase(), r.source_url.trim());
    }
  } catch (err) {
    console.error(
      "[db] scraper.db unavailable — continuing without scrape URLs:",
      err instanceof Error ? err.message : err,
    );
    scrapeSourceCache = new Map();
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
  return scrapeSourceCache;
}

function openReadonly(name: string): Database.Database {
  return openSqliteNamed(name, { readonly: true, fileMustExist: true });
}

function getAbout(): Database.Database {
  if (aboutDb) return aboutDb;
  aboutDb = openReadonly("company_about.db");
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
  llm_about: string | null;
  scraped_about: string | null;
  scraped_about_clean: string | null;
  company_sector: string | null;
  company_industry: string | null;
  headquarters: string | null;
  ceo: string | null;
  managing_director: string | null;
  founded_year: string | null;
  products: string | null;
  end_markets: string | null;
  theme_tags: string | null;
};

function normalizeForDedupe(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * When true, LLM-cleaned website prose joins Theme Scanner keyword corpus.
 * Default on when scraped_about_clean exists; set USE_CLEAN_SCRAPE_IN_THEMES=0 to disable.
 */
export function useCleanScrapeInThemes(): boolean {
  const v = process.env.USE_CLEAN_SCRAPE_IN_THEMES?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  return true;
}

/**
 * Merge manual, Yahoo, LLM about, and cleaned website summary.
 * Raw website scrapes stay out — nav junk (e.g. a footer “aerospace”) poisoned Theme Scanner.
 */
export function mergeAboutSourcesForThemeSearch(row: {
  about: string | null;
  yf_about: string | null;
  llm_about?: string | null;
  scraped_about?: string | null;
  scraped_about_clean?: string | null;
}): string {
  const sources: Array<string | null> = [
    row.about,
    row.yf_about,
    row.llm_about ?? null,
  ];
  if (useCleanScrapeInThemes()) {
    sources.push(row.scraped_about_clean ?? null);
  }
  const filtered = sources
    .map(nonempty)
    .filter((t): t is string => !!t && t.length >= 40);

  const kept: string[] = [];
  for (const text of filtered) {
    const norm = normalizeForDedupe(text);
    const probe = norm.slice(0, Math.min(norm.length, 240));
    const duplicate = kept.some((k) => {
      const kn = normalizeForDedupe(k);
      return kn.includes(probe) || norm.includes(kn.slice(0, Math.min(kn.length, 240)));
    });
    if (!duplicate) kept.push(text);
  }
  return kept.join("\n\n");
}

/**
 * Merge manual, Yahoo, and website-scrape prose for general keyword search.
 * Display still uses {@link pickAboutText}; theme matching uses {@link mergeAboutSourcesForThemeSearch}.
 */
export function mergeAboutSourcesForSearch(row: {
  about: string | null;
  yf_about: string | null;
  scraped_about: string | null;
}): string {
  const scrape = looksLikeNavJunk(row.scraped_about ?? "")
    ? extractWebsiteSignal(row.scraped_about)
    : row.scraped_about;
  const sources = [row.about, row.yf_about, scrape]
    .map(nonempty)
    .filter(
      (t): t is string => !!t && t.length >= 40,
    );

  const kept: string[] = [];
  for (const text of sources) {
    const norm = normalizeForDedupe(text);
    const probe = norm.slice(0, Math.min(norm.length, 240));
    const duplicate = kept.some((k) => {
      const kn = normalizeForDedupe(k);
      return kn.includes(probe) || norm.includes(kn.slice(0, Math.min(kn.length, 240)));
    });
    if (!duplicate) kept.push(text);
  }
  return kept.join("\n\n");
}

function buildThemeSearchText(
  row: RawAbout,
  sector?: string | null,
  sub?: string | null,
): string {
  const aboutCorpus = mergeAboutSourcesForThemeSearch(row);
  return [
    row.headquarters,
    row.name,
    row.ticker,
    aboutCorpus,
    row.products,
    row.end_markets,
    row.theme_tags,
    sector,
    sub,
    row.headquarters,
  ]
    .filter(Boolean)
    .join(" \n ");
}

function buildSearchText(
  row: RawAbout,
  sector?: string | null,
  sub?: string | null,
): string {
  const aboutCorpus = mergeAboutSourcesForSearch(row);
  // HQ first so location themes (e.g. Mumbai) can AND with about terms.
  return [
    row.headquarters,
    row.name,
    row.ticker,
    aboutCorpus,
    row.products,
    row.end_markets,
    row.theme_tags,
    sector,
    sub,
    row.headquarters,
  ]
    .filter(Boolean)
    .join(" \n ");
}

/** Rich text for LLM business briefs — Theme Scanner corpus plus cleaned website summary. */
export function buildCompanyDossierText(row: {
  name: string;
  ticker: string;
  market: string;
  sector: string | null;
  sub_sector: string | null;
  headquarters: string | null;
  mcap_cr: number | null;
  theme_search_text: string;
  scraped_about_clean: string | null;
}): string {
  const header = [
    `${row.name} (${row.ticker}) · ${row.market}`,
    row.sector || row.sub_sector
      ? `Sector: ${[row.sector, row.sub_sector].filter(Boolean).join(" / ")}`
      : null,
    row.headquarters ? `HQ: ${row.headquarters}` : null,
    row.mcap_cr != null ? `Mcap: ₹${Math.round(row.mcap_cr)} Cr` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const blocks = [header];
  const themeText = row.theme_search_text?.trim();
  if (themeText) blocks.push(`Company profile:\n${themeText.slice(0, 4500)}`);

  const clean = row.scraped_about_clean?.trim();
  if (clean && clean.length >= 80 && !looksLikeNavJunk(clean)) {
    const normTheme = normalizeForDedupe(themeText ?? "");
    const probe = normalizeForDedupe(clean).slice(0, Math.min(220, clean.length));
    if (!probe || !normTheme.includes(probe)) {
      blocks.push(`Website summary (cleaned):\n${clean.slice(0, 2200)}`);
    }
  }

  return blocks.join("\n\n");
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
  const scrapeSources = loadScrapeSourceMap();

  return rows.map((row) => {
    const cls = pickClass(classMaps, row.ticker, row.market);
    const g = govMap.get(row.ticker);
    const m = metricsMap.get(row.ticker.toUpperCase());

    // Prefer listing taxonomy (classifications.db), then Yahoo about, then governance, then YF quote sector.
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
    const name = resolveCompanyName(row, about);
    const searchRow = { ...row, name };

    const theme_search_text = buildThemeSearchText(searchRow, sector, sub_sector);

    const enriched = {
      ticker: row.ticker,
      name,
      market: row.market,
      website: row.website,
      about,
      scraped_about: nonempty(row.scraped_about),
      scraped_about_clean: nonempty(row.scraped_about_clean),
      llm_about: nonempty(row.llm_about),
      scrape_source_url: scrapeSources.get(row.ticker.toUpperCase()) ?? null,
      headquarters: nonempty(row.headquarters),
      ceo: nonempty(row.ceo),
      managing_director: nonempty(row.managing_director),
      founded_year: nonempty(row.founded_year),
      sector,
      sub_sector,
      price: m?.price ?? null,
      mcap_cr: m?.market_cap_cr ?? null,
      search_text: buildSearchText(searchRow, sector, sub_sector),
      theme_search_text,
      web: links.web,
      sc: links.sc,
      tv: links.tv,
    };

    return {
      ...enriched,
      dossier_text: buildCompanyDossierText(enriched),
    };
  });
}

function nonempty(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

/** BSE sometimes stores SCRIP_CD (e.g. 1201) instead of Issuer_Name in `name`. */
function looksLikeScripCodeName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  return /^\d{1,6}$/.test(n);
}

/** Parse "Acme Widgets Limited designs…" from Yahoo/BSE about prose. */
export function nameFromAboutText(
  about: string | null | undefined,
): string | null {
  const text = (about ?? "").trim();
  if (text.length < 20) return null;
  const m = text.match(
    /^(.{3,120}?)\s+(designs|engages|operates|provides|manufactures|develops|offers|is an|is a|specializes|focuses|distributes|produces|supplies|markets|trades in)\b/i,
  );
  return m?.[1]?.trim() || null;
}

function resolveCompanyName(row: RawAbout, about: string | null): string {
  const stored = nonempty(row.name);
  if (stored && !looksLikeScripCodeName(stored)) return stored;
  const parsed = nameFromAboutText(about ?? row.about ?? row.yf_about);
  if (parsed) return parsed;
  return stored || row.ticker;
}

/** Nav-scrape / menu dump heuristic (e.g. "About Us Investor Relations Career…"). */
export function looksLikeNavJunk(text: string): boolean {
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

function isNavLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 20) return true;
  if (
    /^(home|about(\s+us)?|contact|careers?|investors?|login|menu|search|privacy|cookies?)$/i.test(
      t,
    )
  ) {
    return true;
  }
  const navHits = (
    t.match(
      /\b(About Us|Investor Relations|Board of Directors|Corporate Governance|Press and Media|Leadership Team|Careers?|CSR|Cookie)\b/gi,
    ) || []
  ).length;
  return navHits >= 2 && t.length < 140;
}

/**
 * Pull usable business prose out of a raw website scrape (menus, IR chrome).
 * Used when cleaned scrape is missing so search can still hit CDMO/CRAMS etc.
 */
export function extractWebsiteSignal(
  raw: string | null | undefined,
  maxLen = 2800,
): string {
  const t = (raw ?? "").trim();
  if (t.length < 40) return "";

  const lines = t
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 24 && !isNavLine(l));

  let out = lines.join(" ").replace(/\s+/g, " ").trim();
  if (out.length < 80) {
    const sentences = t
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 48 && !isNavLine(s));
    out = sentences.join(" ").replace(/\s+/g, " ").trim();
  }
  if (out.length < 80 && !looksLikeNavJunk(t)) {
    out = t.replace(/\s+/g, " ").trim();
  }
  if (out.length <= maxLen) return out;
  return `${out.slice(0, maxLen).trim()}…`;
}

/** Prose usable as company about (Yahoo, manual, scraped, etc.). */
export function hasUsableAboutText(text: string | null | undefined): boolean {
  const t = nonempty(text);
  if (!t || t.length < 40) return false;
  if (looksLikeNavJunk(t)) return false;
  return true;
}

/** Yahoo Finance longBusinessSummary is usable (website scrape not needed). */
export function hasUsableYfAbout(row: {
  yf_about: string | null;
}): boolean {
  return hasUsableAboutText(row.yf_about);
}

/**
 * Display About only (Screener manual + Yahoo). Website scrape stays on the Website tab;
 * general search uses {@link mergeAboutSourcesForSearch}; Theme Scanner uses {@link mergeAboutSourcesForThemeSearch}.
 */
export function pickAboutText(row: {
  about: string | null;
  yf_about?: string | null;
  llm_about?: string | null;
  scraped_about?: string | null;
}): string | null {
  const about = nonempty(row.about);
  const yf = nonempty(row.yf_about);
  const llm = nonempty(row.llm_about);

  if (yf && !looksLikeNavJunk(yf) && about && looksLikeNavJunk(about)) {
    return yf;
  }
  const candidates = [about, yf, llm].filter(Boolean) as string[];
  const clean = candidates.find((c) => !looksLikeNavJunk(c));
  return clean || yf || about || llm || null;
}

/** Drop in-memory company cache (call after Yahoo fill / website scrape). */
export function invalidateCompanyCache(): void {
  cache = null;
  scrapeSourceCache = null;
  try {
    aboutDb?.close();
  } catch {
    /* ignore */
  }
  aboutDb = null;
  try {
    govDb?.close();
  } catch {
    /* ignore */
  }
  govDb = null;
  try {
    classDb?.close();
  } catch {
    /* ignore */
  }
  classDb = null;
}

export function loadAllCompanies(): CompanyRow[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.rows;

  if (ensureScrapeCleanSchema() && aboutDb) {
    try {
      aboutDb.close();
    } catch {
      /* ignore */
    }
    aboutDb = null;
  }
  if (ensureLlmAboutSchema() && aboutDb) {
    try {
      aboutDb.close();
    } catch {
      /* ignore */
    }
    aboutDb = null;
  }
  if (ensureWebProfileSchema() && aboutDb) {
    try {
      aboutDb.close();
    } catch {
      /* ignore */
    }
    aboutDb = null;
  }

  ensureInvestorMaterialsSchema();

  const db = getAbout();
  const rows = db
    .prepare(
      `SELECT ticker, name, market, website, about, yf_about, scraped_about,
              scraped_about_clean, llm_about,
              company_sector, company_industry, headquarters,
              ceo, managing_director, founded_year,
              products, end_markets, theme_tags
       FROM company_about ORDER BY ticker`,
    )
    .all() as RawAbout[];

  const seen = new Set<string>();
  const unique: RawAbout[] = [];
  for (const row of rows) {
    const key = row.ticker.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  unique.sort((a, b) =>
    (a.name || a.ticker).localeCompare(b.name || b.ticker, undefined, {
      sensitivity: "base",
    }),
  );

  const enriched = enrichAll(unique);
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
