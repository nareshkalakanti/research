/**
 * Quality watchlist — Screener screen (sales/profit growth, ROE/ROCE, low debt, OPM, promoters).
 * data/quality.db · seed from data/quality-screener.json
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "quality.db");

export type QualityRow = {
  ticker: string;
  name: string | null;
  market: string;
  sources: string;
};

let cache: { at: number; set: Set<string>; rows: QualityRow[] } | null = null;
const CACHE_MS = 30_000;

function open(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quality (
      ticker TEXT PRIMARY KEY,
      market TEXT,
      name TEXT,
      sources TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
}

export function invalidateQualityCache(): void {
  cache = null;
}

export function loadQuality(): QualityRow[] {
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
        `SELECT ticker, name, market, sources FROM quality ORDER BY ticker COLLATE NOCASE`,
      )
      .all() as QualityRow[];
    const set = new Set(rows.map((r) => r.ticker.toUpperCase()));
    cache = { at: now, set, rows };
    return rows;
  } finally {
    db.close();
  }
}

export function qualityTickerSet(): Set<string> {
  loadQuality();
  return cache?.set ?? new Set();
}

export function isQuality(ticker: string): boolean {
  return qualityTickerSet().has(ticker.toUpperCase());
}

export function replaceQuality(
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
      db.exec("DELETE FROM quality");
      const ins = db.prepare(
        `INSERT INTO quality (ticker, market, name, sources, updated_at)
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
          (r.sources || "screener_quality").trim(),
          now,
        );
        n += 1;
      }
      return n;
    });
    const n = tx() as number;
    invalidateQualityCache();
    return n;
  } finally {
    db.close();
  }
}
