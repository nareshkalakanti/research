/**
 * SOIC watchlist — SOIC × StockScans Fastest Growing Businesses (Q1 FY27).
 * data/soic.db
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "soic.db");

export type SoicRow = {
  ticker: string;
  name: string | null;
  market: string;
  sources: string;
};

let cache: { at: number; set: Set<string>; rows: SoicRow[] } | null = null;
const CACHE_MS = 30_000;

function open(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS soic (
      ticker TEXT PRIMARY KEY,
      market TEXT,
      name TEXT,
      sources TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
}

export function invalidateSoicCache(): void {
  cache = null;
}

export function loadSoic(): SoicRow[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.rows;

  const db = open();
  if (!db) {
    cache = { at: now, set: new Set(), rows: [] };
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT ticker, name, market, sources FROM soic ORDER BY ticker COLLATE NOCASE`,
      )
      .all() as SoicRow[];
    const set = new Set(rows.map((r) => r.ticker.toUpperCase()));
    cache = { at: now, set, rows };
    return rows;
  } finally {
    db.close();
  }
}

export function soicTickerSet(): Set<string> {
  loadSoic();
  return cache?.set ?? new Set();
}

export function isSoic(ticker: string): boolean {
  return soicTickerSet().has(ticker.toUpperCase());
}

export function replaceSoic(
  rows: Array<{
    ticker: string;
    name?: string | null;
    market?: string | null;
    sources?: string | null;
  }>,
): number {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  try {
    ensureSchema(db);
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.exec("DELETE FROM soic");
      const ins = db.prepare(
        `INSERT INTO soic (ticker, market, name, sources, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      let n = 0;
      for (const r of rows) {
        const ticker = (r.ticker || "").trim().toUpperCase();
        if (!ticker) continue;
        ins.run(
          ticker,
          (r.market || "NSE").toUpperCase(),
          r.name?.trim() || null,
          (r.sources || "soic_q1fy27").trim(),
          now,
        );
        n += 1;
      }
      return n;
    });
    const n = tx() as number;
    invalidateSoicCache();
    return n;
  } finally {
    db.close();
  }
}
