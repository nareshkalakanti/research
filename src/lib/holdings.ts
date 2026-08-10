/**
 * Personal holdings — data/holdings.db (synced from stocks-ai).
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "holdings.db");

export type HoldingRow = {
  ticker: string;
  name: string | null;
  market: string;
  sector: string | null;
  sub_sector: string | null;
};

let cache: { at: number; set: Set<string>; rows: HoldingRow[] } | null = null;
const CACHE_MS = 30_000;

function open(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS holdings (
      ticker TEXT PRIMARY KEY,
      market TEXT,
      name TEXT,
      sector TEXT,
      sub_sector TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

export function invalidateHoldingsCache(): void {
  cache = null;
}

export function loadHoldings(): HoldingRow[] {
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
        `SELECT ticker, name, market, sector, sub_sector
         FROM holdings ORDER BY ticker COLLATE NOCASE`,
      )
      .all() as HoldingRow[];
    const set = new Set(rows.map((r) => r.ticker.toUpperCase()));
    cache = { at: now, set, rows };
    return rows;
  } finally {
    db.close();
  }
}

export function holdingsTickerSet(): Set<string> {
  loadHoldings();
  return cache?.set ?? new Set();
}

export function isHolding(ticker: string): boolean {
  return holdingsTickerSet().has(ticker.toUpperCase());
}

/** Replace all holdings (used by sync script). */
export function replaceHoldings(
  rows: Array<{
    ticker: string;
    name?: string | null;
    market?: string | null;
    sector?: string | null;
    sub_sector?: string | null;
  }>,
): number {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  try {
    ensureSchema(db);
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.exec("DELETE FROM holdings");
      const ins = db.prepare(
        `INSERT INTO holdings (ticker, market, name, sector, sub_sector, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      let n = 0;
      for (const r of rows) {
        const ticker = (r.ticker || "").trim().toUpperCase();
        if (!ticker) continue;
        ins.run(
          ticker,
          (r.market || "NSE").toUpperCase(),
          r.name?.trim() || null,
          r.sector?.trim() || null,
          r.sub_sector?.trim() || null,
          now,
        );
        n += 1;
      }
      return n;
    });
    const n = tx() as number;
    invalidateHoldingsCache();
    return n;
  } finally {
    db.close();
  }
}
