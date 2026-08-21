/**
 * Saved keyword searches — data/saved_searches.db.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "saved_searches.db");

export type SavedSearchScope = "theme" | "watching";

export type SavedSearchRow = {
  id: number;
  name: string;
  pattern: string;
  theme_ids: string[];
  scope: SavedSearchScope;
  created_at: string;
  updated_at: string;
};

let cache: { at: number; rows: SavedSearchRow[] } | null = null;
const CACHE_MS = 5_000;

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pattern TEXT NOT NULL,
      theme_ids TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'theme',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(name COLLATE NOCASE, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_searches_scope
      ON saved_searches(scope, updated_at DESC);
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

function parseThemeIds(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function rowFromDb(r: Record<string, unknown>): SavedSearchRow {
  return {
    id: Number(r.id),
    name: String(r.name ?? ""),
    pattern: String(r.pattern ?? ""),
    theme_ids: parseThemeIds(String(r.theme_ids ?? "")),
    scope: r.scope === "watching" ? "watching" : "theme",
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
  };
}

export function invalidateSavedSearchesCache(): void {
  cache = null;
}

function loadAll(): SavedSearchRow[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.rows;

  const db = openReadonly();
  if (!db) {
    cache = { at: now, rows: [] };
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT id, name, pattern, theme_ids, scope, created_at, updated_at
         FROM saved_searches
         ORDER BY updated_at DESC, id DESC`,
      )
      .all() as Record<string, unknown>[];
    const parsed = rows.map(rowFromDb);
    cache = { at: now, rows: parsed };
    return parsed;
  } finally {
    db.close();
  }
}

export function listSavedSearches(scope?: SavedSearchScope): SavedSearchRow[] {
  const rows = loadAll();
  if (!scope) return rows;
  return rows.filter((r) => r.scope === scope);
}

export function getSavedSearch(id: number): SavedSearchRow | null {
  return loadAll().find((r) => r.id === id) ?? null;
}

export function upsertSavedSearch(input: {
  name: string;
  pattern: string;
  theme_ids?: string[];
  scope: SavedSearchScope;
}): SavedSearchRow {
  const name = input.name.trim();
  const pattern = input.pattern.trim();
  if (!name) throw new Error("name required");
  if (!pattern && !(input.theme_ids?.length ?? 0)) {
    throw new Error("pattern or themes required");
  }

  const themeIds = [...new Set((input.theme_ids ?? []).map((s) => s.trim()).filter(Boolean))];
  const themeCsv = themeIds.join(",");
  const now = new Date().toISOString();
  const db = openWritable();
  try {
    const existing = db
      .prepare(
        `SELECT id FROM saved_searches
         WHERE LOWER(name) = LOWER(?) AND scope = ?`,
      )
      .get(name, input.scope) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE saved_searches
         SET pattern = ?, theme_ids = ?, updated_at = ?
         WHERE id = ?`,
      ).run(pattern, themeCsv, now, existing.id);
      invalidateSavedSearchesCache();
      return getSavedSearch(existing.id)!;
    }

    const info = db
      .prepare(
        `INSERT INTO saved_searches (name, pattern, theme_ids, scope, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(name, pattern, themeCsv, input.scope, now, now);
    invalidateSavedSearchesCache();
    return getSavedSearch(Number(info.lastInsertRowid))!;
  } finally {
    db.close();
  }
}

export function deleteSavedSearch(id: number): boolean {
  const db = openWritable();
  try {
    const info = db.prepare(`DELETE FROM saved_searches WHERE id = ?`).run(id);
    invalidateSavedSearchesCache();
    return info.changes > 0;
  } finally {
    db.close();
  }
}
