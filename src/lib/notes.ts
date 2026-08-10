/**
 * Per-ticker research notes — data/notes.db.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "notes.db");

export type NoteRow = {
  ticker: string;
  body: string;
  updated_at: string;
};

let cache: { at: number; set: Set<string>; map: Map<string, NoteRow> } | null =
  null;
const CACHE_MS = 15_000;

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      ticker TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function openReadonly(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

function openWritable(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  ensureSchema(db);
  return db;
}

export function invalidateNotesCache(): void {
  cache = null;
}

function loadCache(): {
  set: Set<string>;
  map: Map<string, NoteRow>;
} {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) {
    return { set: cache.set, map: cache.map };
  }

  const map = new Map<string, NoteRow>();
  const db = openReadonly();
  if (db) {
    try {
      const rows = db
        .prepare(
          `SELECT ticker, body, updated_at FROM notes
           WHERE trim(body) != ''
           ORDER BY updated_at DESC`,
        )
        .all() as NoteRow[];
      for (const r of rows) {
        map.set(r.ticker.toUpperCase(), {
          ticker: r.ticker.toUpperCase(),
          body: r.body,
          updated_at: r.updated_at,
        });
      }
    } finally {
      db.close();
    }
  }
  const set = new Set(map.keys());
  cache = { at: now, set, map };
  return { set, map };
}

export function notesTickerSet(): Set<string> {
  return loadCache().set;
}

export function getNote(ticker: string): NoteRow | null {
  return loadCache().map.get(ticker.toUpperCase()) ?? null;
}

export function listNotes(): NoteRow[] {
  return [...loadCache().map.values()];
}

/** Upsert note. Empty body deletes the row. */
export function upsertNote(ticker: string, body: string): NoteRow | null {
  const t = ticker.trim().toUpperCase();
  if (!t) return null;
  const text = body.replace(/\r\n/g, "\n").trim();
  const db = openWritable();
  try {
    if (!text) {
      db.prepare(`DELETE FROM notes WHERE UPPER(ticker) = ?`).run(t);
      invalidateNotesCache();
      return null;
    }
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO notes (ticker, body, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET
         body = excluded.body,
         updated_at = excluded.updated_at`,
    ).run(t, text, now);
    invalidateNotesCache();
    return { ticker: t, body: text, updated_at: now };
  } finally {
    db.close();
  }
}

export function deleteNote(ticker: string): boolean {
  const t = ticker.trim().toUpperCase();
  if (!t) return false;
  const db = openWritable();
  try {
    const info = db
      .prepare(`DELETE FROM notes WHERE UPPER(ticker) = ?`)
      .run(t);
    invalidateNotesCache();
    return info.changes > 0;
  } finally {
    db.close();
  }
}
