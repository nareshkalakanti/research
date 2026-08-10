/**
 * Edge watchlist — Early Edge + Negen + Niveshaay merged (data/edge.db).
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "edge.db");

export type EdgeRow = {
  ticker: string;
  name: string | null;
  market: string;
  /** Comma-separated source keys: early_edge, negen, niveshaay */
  sources: string;
};

let cache: { at: number; set: Set<string>; rows: EdgeRow[] } | null = null;
const CACHE_MS = 30_000;

function open(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edge (
      ticker TEXT PRIMARY KEY,
      market TEXT,
      name TEXT,
      sources TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
}

export function invalidateEdgeCache(): void {
  cache = null;
}

export function loadEdge(): EdgeRow[] {
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
        `SELECT ticker, name, market, sources FROM edge ORDER BY ticker COLLATE NOCASE`,
      )
      .all() as EdgeRow[];
    const set = new Set(rows.map((r) => r.ticker.toUpperCase()));
    cache = { at: now, set, rows };
    return rows;
  } finally {
    db.close();
  }
}

export function edgeTickerSet(): Set<string> {
  loadEdge();
  return cache?.set ?? new Set();
}

export function isEdge(ticker: string): boolean {
  return edgeTickerSet().has(ticker.toUpperCase());
}

export function replaceEdge(
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
      db.exec("DELETE FROM edge");
      const ins = db.prepare(
        `INSERT INTO edge (ticker, market, name, sources, updated_at)
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
          (r.sources || "").trim(),
          now,
        );
        n += 1;
      }
      return n;
    });
    const n = tx() as number;
    invalidateEdgeCache();
    return n;
  } finally {
    db.close();
  }
}
