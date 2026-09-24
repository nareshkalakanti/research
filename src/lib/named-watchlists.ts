/**
 * Named ticker lists (e.g. Alpha) — data/named_watchlists.db
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "named_watchlists.db");

export type NamedWatchRow = {
  list_key: string;
  ticker: string;
  name: string | null;
  market: string;
  sector: string | null;
  sub_sector: string | null;
};

function normalizeListKey(listKey: string): string {
  return listKey.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "");
}

function openWrite(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS named_watchlists (
      list_key TEXT NOT NULL,
      ticker TEXT NOT NULL,
      market TEXT,
      name TEXT,
      sector TEXT,
      sub_sector TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (list_key, ticker)
    );
    CREATE TABLE IF NOT EXISTS named_list_meta (
      list_key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureMetaRows(db);
  return db;
}

function openRead(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

function titleFromKey(key: string): string {
  const t = key.replace(/[_-]+/g, " ").trim();
  if (!t) return key;
  return t.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function ensureMetaRows(db: Database.Database): void {
  const now = new Date().toISOString();
  const keys = db
    .prepare(`SELECT DISTINCT list_key FROM named_watchlists`)
    .all() as Array<{ list_key: string }>;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO named_list_meta (list_key, label, created_at)
     VALUES (?, ?, ?)`,
  );
  for (const row of keys) {
    ins.run(row.list_key, titleFromKey(row.list_key), now);
  }
}

export type NamedListInfo = {
  key: string;
  label: string;
  tickers: string[];
  count: number;
};

export function listNamedWatchlists(): NamedListInfo[] {
  const db = openRead();
  if (!db) return [];
  try {
    const hasMeta = db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'named_list_meta'`,
      )
      .get();
    const memberRows = db
      .prepare(
        `SELECT list_key, ticker FROM named_watchlists ORDER BY ticker COLLATE NOCASE`,
      )
      .all() as Array<{ list_key: string; ticker: string }>;
    const byKey = new Map<string, string[]>();
    for (const row of memberRows) {
      const t = (row.ticker || "").toUpperCase();
      if (!t) continue;
      const list = byKey.get(row.list_key) ?? [];
      list.push(t);
      byKey.set(row.list_key, list);
    }
    const meta = hasMeta
      ? (db
          .prepare(`SELECT list_key, label FROM named_list_meta ORDER BY created_at, label`)
          .all() as Array<{ list_key: string; label: string }>)
      : [];
    const seen = new Set<string>();
    const out: NamedListInfo[] = [];
    for (const m of meta) {
      seen.add(m.list_key);
      const tickers = byKey.get(m.list_key) ?? [];
      out.push({
        key: m.list_key,
        label: m.label || titleFromKey(m.list_key),
        tickers,
        count: tickers.length,
      });
    }
    for (const [key, tickers] of byKey) {
      if (seen.has(key)) continue;
      out.push({
        key,
        label: titleFromKey(key),
        tickers,
        count: tickers.length,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

export function createNamedList(labelRaw: string): NamedListInfo | null {
  const label = labelRaw.trim().replace(/\s+/g, " ");
  if (!label || label.length > 32) return null;
  const key = normalizeListKey(label);
  if (
    !key ||
    key === "watch" ||
    key === "watchlist" ||
    key === "holdings" ||
    key === "common"
  ) {
    return null;
  }
  const db = openWrite();
  try {
    db.prepare(
      `INSERT OR IGNORE INTO named_list_meta (list_key, label, created_at)
       VALUES (?, ?, ?)`,
    ).run(key, label, new Date().toISOString());
    db.prepare(`UPDATE named_list_meta SET label = ? WHERE list_key = ?`).run(
      label,
      key,
    );
  } finally {
    db.close();
  }
  return listNamedWatchlists().find((l) => l.key === key) ?? { key, label, tickers: [], count: 0 };
}

export function renameNamedList(
  listKey: string,
  labelRaw: string,
): NamedListInfo | null {
  const key = normalizeListKey(listKey);
  const label = labelRaw.trim().replace(/\s+/g, " ");
  if (!key || !label || label.length > 32) return null;
  const reserved = normalizeListKey(label);
  if (
    reserved === "watch" ||
    reserved === "watchlist" ||
    reserved === "holdings" ||
    reserved === "common"
  ) {
    return null;
  }
  const db = openWrite();
  try {
    const exists = db
      .prepare(`SELECT 1 FROM named_list_meta WHERE list_key = ?`)
      .get(key);
    if (!exists) return null;
    db.prepare(`UPDATE named_list_meta SET label = ? WHERE list_key = ?`).run(
      label,
      key,
    );
  } finally {
    db.close();
  }
  return listNamedWatchlists().find((l) => l.key === key) ?? null;
}

export function loadNamedWatchlist(listKey: string): NamedWatchRow[] {
  const key = normalizeListKey(listKey);
  if (!key) return [];
  const db = openRead();
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT list_key, ticker, name, market, sector, sub_sector
         FROM named_watchlists
         WHERE list_key = ?
         ORDER BY ticker COLLATE NOCASE`,
      )
      .all(key) as NamedWatchRow[];
  } finally {
    db.close();
  }
}

export function upsertNamedWatch(
  listKey: string,
  row: {
    ticker: string;
    name?: string | null;
    market?: string | null;
    sector?: string | null;
    sub_sector?: string | null;
  },
): NamedWatchRow | null {
  const key = normalizeListKey(listKey);
  const ticker = (row.ticker || "").trim().toUpperCase();
  if (!key || !ticker) return null;
  const db = openWrite();
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO named_watchlists
         (list_key, ticker, market, name, sector, sub_sector, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(list_key, ticker) DO UPDATE SET
         market = excluded.market,
         name = COALESCE(excluded.name, named_watchlists.name),
         sector = COALESCE(excluded.sector, named_watchlists.sector),
         sub_sector = COALESCE(excluded.sub_sector, named_watchlists.sub_sector),
         updated_at = excluded.updated_at`,
    ).run(
      key,
      ticker,
      (row.market || "NSE").trim().toUpperCase() || "NSE",
      row.name?.trim() || null,
      row.sector?.trim() || null,
      row.sub_sector?.trim() || null,
      now,
    );
    db.prepare(
      `INSERT OR IGNORE INTO named_list_meta (list_key, label, created_at)
       VALUES (?, ?, ?)`,
    ).run(key, titleFromKey(key), now);
    return (
      loadNamedWatchlist(key).find((h) => h.ticker.toUpperCase() === ticker) ?? {
        list_key: key,
        ticker,
        name: row.name?.trim() || null,
        market: (row.market || "NSE").trim().toUpperCase() || "NSE",
        sector: row.sector?.trim() || null,
        sub_sector: row.sub_sector?.trim() || null,
      }
    );
  } finally {
    db.close();
  }
}

export function deleteNamedWatch(listKey: string, ticker: string): boolean {
  const key = normalizeListKey(listKey);
  const t = (ticker || "").trim().toUpperCase();
  if (!key || !t || !fs.existsSync(DB_PATH)) return false;
  const db = openWrite();
  try {
    const info = db
      .prepare(
        `DELETE FROM named_watchlists WHERE list_key = ? AND UPPER(ticker) = ?`,
      )
      .run(key, t);
    return info.changes > 0;
  } finally {
    db.close();
  }
}

export function replaceNamedWatchlist(
  listKey: string,
  rows: Array<{
    ticker: string;
    name?: string | null;
    market?: string | null;
    sector?: string | null;
    sub_sector?: string | null;
  }>,
): number {
  const key = normalizeListKey(listKey);
  if (!key) return 0;
  const db = openWrite();
  try {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM named_watchlists WHERE list_key = ?`).run(key);
      const ins = db.prepare(
        `INSERT INTO named_watchlists
           (list_key, ticker, market, name, sector, sub_sector, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const seen = new Set<string>();
      let n = 0;
      for (const r of rows) {
        const ticker = (r.ticker || "").trim().toUpperCase();
        if (!ticker || seen.has(ticker)) continue;
        seen.add(ticker);
        ins.run(
          key,
          ticker,
          (r.market || "NSE").trim().toUpperCase() || "NSE",
          r.name?.trim() || null,
          r.sector?.trim() || null,
          r.sub_sector?.trim() || null,
          now,
        );
        n += 1;
      }
      return n;
    });
    return tx() as number;
  } finally {
    db.close();
  }
}

export function deleteNamedWatchTicker(ticker: string): number {
  const t = (ticker || "").trim().toUpperCase();
  if (!t || !fs.existsSync(DB_PATH)) return 0;
  const db = openWrite();
  try {
    const info = db
      .prepare(`DELETE FROM named_watchlists WHERE UPPER(ticker) = ?`)
      .run(t);
    return Number(info.changes) || 0;
  } finally {
    db.close();
  }
}
