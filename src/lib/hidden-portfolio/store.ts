/**
 * SQLite cache for Hidden Portfolio scan results (12h TTL).
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { CACHE_TTL_MS, type HiddenCandidate } from "./config";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "hidden_portfolio.db");

/** Canonical cache key — always `.NS` suffix for NSE names. */
export function canonicalSymbol(symbol: string): string {
  let s = symbol.trim().toUpperCase();
  if (!s) return s;
  if (s.endsWith(".NS") || s.endsWith(".BO")) return s;
  if (s.endsWith("-SM")) return `${s}.NS`;
  return `${s}.NS`;
}

function symbolLookupKeys(symbol: string): string[] {
  const c = canonicalSymbol(symbol);
  const bare = c.replace(/-SM\.NS$/i, "").replace(/\.(NS|BO)$/i, "");
  return [...new Set([c, bare, `${bare}.NS`, `${bare}-SM.NS`])];
}

function openDb(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      symbol TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      alpha_score REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      universe_count INTEGER,
      filtered_count INTEGER,
      note TEXT
    );
  `);
  return db;
}

export function getCachedCandidate(
  symbol: string,
): HiddenCandidate | null {
  const db = openDb();
  try {
    for (const key of symbolLookupKeys(symbol)) {
      const row = db
        .prepare(
          `SELECT payload, fetched_at FROM candidates WHERE symbol = ?`,
        )
        .get(key) as
        | { payload: string; fetched_at: string }
        | undefined;
      if (!row) continue;
      const age = Date.now() - Date.parse(row.fetched_at);
      if (!Number.isFinite(age) || age > CACHE_TTL_MS) continue;
      return JSON.parse(row.payload) as HiddenCandidate;
    }
    return null;
  } finally {
    db.close();
  }
}

/** Drop cached rows so the next scan always refetches. */
export function invalidateCandidates(symbols: string[]): number {
  if (!symbols.length) return 0;
  const keys = new Set<string>();
  for (const s of symbols) {
    for (const k of symbolLookupKeys(s)) keys.add(k);
  }
  const db = openDb();
  try {
    const stmt = db.prepare(`DELETE FROM candidates WHERE symbol = ?`);
    let n = 0;
    for (const k of keys) {
      n += stmt.run(k).changes;
    }
    return n;
  } finally {
    db.close();
  }
}

export function upsertCandidate(c: HiddenCandidate): void {
  const db = openDb();
  const key = canonicalSymbol(c.symbol);
  try {
    // Remove legacy alias keys (DHRUV vs DHRUV.NS duplicates).
    for (const alias of symbolLookupKeys(c.symbol)) {
      if (alias !== key) {
        db.prepare(`DELETE FROM candidates WHERE symbol = ?`).run(alias);
      }
    }
    db.prepare(
      `INSERT INTO candidates (symbol, payload, fetched_at, alpha_score)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET
         payload = excluded.payload,
         fetched_at = excluded.fetched_at,
         alpha_score = excluded.alpha_score`,
    ).run(
      key,
      JSON.stringify({ ...c, symbol: key }),
      c.fetched_at,
      c.alpha_score,
    );
  } finally {
    db.close();
  }
}

export function listCachedCandidates(opts?: {
  minScore?: number;
  limit?: number;
}): HiddenCandidate[] {
  const db = openDb();
  try {
    const min = opts?.minScore ?? 0;
    const limit = opts?.limit ?? 200;
    const rows = db
      .prepare(
        `SELECT payload, fetched_at FROM candidates
         WHERE alpha_score >= ?
         ORDER BY alpha_score DESC, symbol ASC
         LIMIT ?`,
      )
      .all(min, limit) as Array<{ payload: string; fetched_at: string }>;

    const out: HiddenCandidate[] = [];
    const now = Date.now();
    for (const r of rows) {
      const age = now - Date.parse(r.fetched_at);
      if (!Number.isFinite(age) || age > CACHE_TTL_MS) continue;
      try {
        out.push(JSON.parse(r.payload) as HiddenCandidate);
      } catch {
        /* skip */
      }
    }
    return out;
  } finally {
    db.close();
  }
}

export function recordRun(meta: {
  universe_count: number;
  filtered_count: number;
  note?: string;
}): void {
  const db = openDb();
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs (started_at, finished_at, universe_count, filtered_count, note)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      now,
      now,
      meta.universe_count,
      meta.filtered_count,
      meta.note ?? null,
    );
  } finally {
    db.close();
  }
}

export function latestRunMeta(): {
  finished_at: string;
  universe_count: number;
  filtered_count: number;
} | null {
  const db = openDb();
  try {
    const row = db
      .prepare(
        `SELECT finished_at, universe_count, filtered_count FROM runs
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as
      | {
          finished_at: string;
          universe_count: number;
          filtered_count: number;
        }
      | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}
