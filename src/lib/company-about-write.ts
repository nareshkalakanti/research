import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { invalidateCompanyCache, loadAllCompanies } from "./db";
import { upsertScrapeResult } from "./scraper-store";

const DATA_DIR = path.join(process.cwd(), "data");
const ABOUT_PATH = path.join(DATA_DIR, "company_about.db");

/** Insert a minimal row so manual edits work for fund-list / export-only tickers. */
export function ensureCompanyAboutRow(
  ticker: string,
  opts?: { name?: string; market?: string },
): boolean {
  if (!fs.existsSync(ABOUT_PATH)) return false;
  const key = ticker.toUpperCase();
  const db = new Database(ABOUT_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    const exists = db
      .prepare(`SELECT 1 AS ok FROM company_about WHERE ticker = ?`)
      .get(key) as { ok: number } | undefined;
    if (exists) return true;

    const fromUniverse = loadAllCompanies().find(
      (c) => c.ticker.toUpperCase() === key,
    );
    const name = opts?.name?.trim() || fromUniverse?.name?.trim() || key;
    const market =
      opts?.market?.trim() || fromUniverse?.market?.trim() || "NSE";

    db.prepare(
      `INSERT INTO company_about (
         ticker, name, market, website, about, yf_about, scraped_about,
         company_sector, company_industry, headquarters,
         products, end_markets, theme_tags, source, fetched_at,
         has_website, has_yf_about, has_scraped_about
       ) VALUES (
         @ticker, @name, @market, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL,
         NULL, NULL, NULL, 'manual-edit', @fetched_at,
         0, 0, 0
       )`,
    ).run({
      ticker: key,
      name,
      market,
      fetched_at: new Date().toISOString(),
    });
    return true;
  } finally {
    db.close();
    invalidateCompanyCache();
  }
}

export function saveScrapedAboutToCompanyAbout(
  ticker: string,
  opts: {
    scraped_about: string | null;
    website_status: string;
    source?: string;
  },
): void {
  if (!fs.existsSync(ABOUT_PATH)) return;
  const key = ticker.toUpperCase();
  const text = opts.scraped_about?.trim() || null;
  const db = new Database(ABOUT_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `UPDATE company_about SET
         scraped_about = @scraped_about,
         has_scraped_about = @has_scraped_about,
         website_status = @website_status,
         source = @source,
         fetched_at = @fetched_at
       WHERE ticker = @ticker`,
    ).run({
      ticker: key,
      scraped_about: text,
      has_scraped_about: text && text.length >= 80 ? 1 : 0,
      website_status: opts.website_status,
      source: opts.source ?? "website-scrape",
      fetched_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
  invalidateCompanyCache();
}

export function updateCompanyWebsite(
  ticker: string,
  website: string,
  opts?: { resetScrape?: boolean },
): boolean {
  if (!fs.existsSync(ABOUT_PATH)) return false;
  if (!ensureCompanyAboutRow(ticker)) return false;
  const key = ticker.toUpperCase();
  let url = website.trim();
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    new URL(url);
  } catch {
    return false;
  }
  const db = new Database(ABOUT_PATH);
  let ok = false;
  try {
    db.pragma("busy_timeout = 5000");
    const res = db
      .prepare(
        `UPDATE company_about SET
           website = @website,
           has_website = 1,
           website_status = NULL,
           fetched_at = @fetched_at
         WHERE ticker = @ticker`,
      )
      .run({
        ticker: key,
        website: url,
        fetched_at: new Date().toISOString(),
      });
    if (opts?.resetScrape) {
      db.prepare(
        `UPDATE company_about SET
           scraped_about = NULL,
           has_scraped_about = 0
         WHERE ticker = @ticker`,
      ).run({ ticker: key });
    }
    ok = res.changes > 0;
  } finally {
    db.close();
  }
  invalidateCompanyCache();
  return ok;
}

export function saveManualScrapedAbout(
  ticker: string,
  scraped_about: string,
): boolean {
  if (!ensureCompanyAboutRow(ticker)) return false;
  const text = scraped_about.trim();
  if (text.length < 40) return false;
  const status = text.length >= 80 ? "ok" : "manual";
  saveScrapedAboutToCompanyAbout(ticker, {
    scraped_about: text,
    website_status: "ok",
    source: "manual-scrape",
  });
  upsertScrapeResult(ticker, {
    scraped_about: text,
    status,
    error: null,
    scrape_source: "website",
  });
  return true;
}

export function saveManualAboutToCompanyAbout(
  ticker: string,
  about: string,
): boolean {
  if (!fs.existsSync(ABOUT_PATH)) return false;
  if (!ensureCompanyAboutRow(ticker)) return false;
  const key = ticker.toUpperCase();
  const text = about.trim();
  if (text.length < 40) return false;
  const db = new Database(ABOUT_PATH);
  let ok = false;
  try {
    db.pragma("busy_timeout = 5000");
    const res = db
      .prepare(
        `UPDATE company_about SET
           about = @about,
           source = @source,
           fetched_at = @fetched_at
         WHERE ticker = @ticker`,
      )
      .run({
        ticker: key,
        about: text,
        source: "manual",
        fetched_at: new Date().toISOString(),
      });
    ok = res.changes > 0;
  } finally {
    db.close();
  }
  invalidateCompanyCache();
  return ok;
}
