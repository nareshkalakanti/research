import type Database from "better-sqlite3";

export const VALUEPICKR_DB = "valuepickr.db";

export function migrateValuepickr(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vp_thread (
      thread_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      company_id TEXT,
      category TEXT,
      created_at TEXT,
      last_activity_at TEXT
    );
    CREATE TABLE IF NOT EXISTS vp_post (
      post_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      posted_at TEXT,
      post_url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      company_id TEXT
    );
    CREATE TABLE IF NOT EXISTS vp_company (
      company_id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      ticker TEXT,
      aliases TEXT,
      mapping_confidence REAL
    );
    CREATE TABLE IF NOT EXISTS vp_author (
      author_id TEXT PRIMARY KEY,
      author_name TEXT NOT NULL,
      first_seen TEXT,
      last_seen TEXT
    );
    CREATE TABLE IF NOT EXISTS vp_meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS vp_post_company ON vp_post(company_id);
    CREATE INDEX IF NOT EXISTS vp_post_thread ON vp_post(thread_id);
    CREATE INDEX IF NOT EXISTS vp_post_author ON vp_post(author_id);
    CREATE INDEX IF NOT EXISTS vp_post_at ON vp_post(posted_at);
    CREATE INDEX IF NOT EXISTS vp_post_hash ON vp_post(content_hash);
    CREATE INDEX IF NOT EXISTS vp_thread_company ON vp_thread(company_id);
  `);
}
