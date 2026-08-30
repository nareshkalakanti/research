import fs from "fs";
import path from "path";
import { openSqliteNamed } from "./sqlite-utils";

const DATA_DIR = path.join(process.cwd(), "data");

let ensured = false;

/** Add scraped_about_clean columns to company_about.db and scraper.db (idempotent). */
export function ensureScrapeCleanSchema(): boolean {
  if (ensured) return false;

  let migrated = false;

  const aboutPath = path.join(DATA_DIR, "company_about.db");
  if (fs.existsSync(aboutPath)) {
    const db = openSqliteNamed("company_about.db", { readonly: false, wal: true });
    try {
      const cols = db
        .prepare(`PRAGMA table_info(company_about)`)
        .all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      if (!names.has("scraped_about_clean")) {
        db.exec(`ALTER TABLE company_about ADD COLUMN scraped_about_clean TEXT`);
        migrated = true;
      }
      if (!names.has("has_scraped_about_clean")) {
        db.exec(
          `ALTER TABLE company_about ADD COLUMN has_scraped_about_clean INTEGER NOT NULL DEFAULT 0`,
        );
        migrated = true;
      }
      if (!names.has("scraped_clean_at")) {
        db.exec(`ALTER TABLE company_about ADD COLUMN scraped_clean_at TEXT`);
        migrated = true;
      }
    } finally {
      db.close();
    }
  }

  const scraperPath = path.join(DATA_DIR, "scraper.db");
  if (fs.existsSync(scraperPath)) {
    const db = openSqliteNamed("scraper.db", { readonly: false, wal: true });
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS company_scrape (
          ticker TEXT PRIMARY KEY,
          scraped_about TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          char_count INTEGER NOT NULL DEFAULT 0,
          scraped_at TEXT,
          updated_at TEXT NOT NULL
        );
      `);
      const cols = db
        .prepare(`PRAGMA table_info(company_scrape)`)
        .all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      if (!names.has("scraped_about_clean")) {
        db.exec(`ALTER TABLE company_scrape ADD COLUMN scraped_about_clean TEXT`);
        migrated = true;
      }
      if (!names.has("scraped_clean_at")) {
        db.exec(`ALTER TABLE company_scrape ADD COLUMN scraped_clean_at TEXT`);
        migrated = true;
      }
      if (!names.has("clean_confidence")) {
        db.exec(`ALTER TABLE company_scrape ADD COLUMN clean_confidence TEXT`);
        migrated = true;
      }
    } finally {
      db.close();
    }
  }

  ensured = true;
  return migrated;
}

export function resetScrapeCleanSchemaCache(): void {
  ensured = false;
}
