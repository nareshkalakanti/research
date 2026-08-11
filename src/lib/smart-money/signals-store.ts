/**
 * SQLite cache for shareholding hits + news signals.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { ShareholdingHit } from "./shareholding";
import type { NewsSignal } from "./news";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "smart_money.db");

function openDb(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS shareholding_hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      company_name TEXT,
      holder_name TEXT NOT NULL,
      investor_ids TEXT NOT NULL,
      primary_hit INTEGER NOT NULL DEFAULT 0,
      pct REAL,
      shares REAL,
      as_of_date TEXT,
      in_sme_universe INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL,
      UNIQUE(symbol, holder_name)
    );
    CREATE TABLE IF NOT EXISTS news_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investor_ids TEXT NOT NULL,
      query TEXT,
      headline TEXT NOT NULL,
      link TEXT,
      published TEXT,
      fetched_at TEXT NOT NULL,
      UNIQUE(headline, link)
    );
    CREATE INDEX IF NOT EXISTS idx_sh_symbol ON shareholding_hits(symbol);
    CREATE INDEX IF NOT EXISTS idx_sh_primary ON shareholding_hits(primary_hit);
    CREATE INDEX IF NOT EXISTS idx_news_fetched ON news_signals(fetched_at);
  `);
  return db;
}

export function upsertShareholdingHits(rows: ShareholdingHit[]): number {
  if (!rows.length) return 0;
  const db = openDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO shareholding_hits (
        symbol, company_name, holder_name, investor_ids, primary_hit,
        pct, shares, as_of_date, in_sme_universe, fetched_at
      ) VALUES (
        @symbol, @company_name, @holder_name, @investor_ids, @primary_hit,
        @pct, @shares, @as_of_date, @in_sme_universe, @fetched_at
      )
      ON CONFLICT(symbol, holder_name) DO UPDATE SET
        company_name = excluded.company_name,
        investor_ids = excluded.investor_ids,
        primary_hit = excluded.primary_hit,
        pct = excluded.pct,
        shares = excluded.shares,
        as_of_date = excluded.as_of_date,
        in_sme_universe = excluded.in_sme_universe,
        fetched_at = excluded.fetched_at
    `);
    let n = 0;
    const tx = db.transaction((batch: ShareholdingHit[]) => {
      for (const r of batch) {
        const info = stmt.run({
          symbol: r.symbol,
          company_name: r.company_name,
          holder_name: r.holder_name,
          investor_ids: r.investor_ids.join(","),
          primary_hit: r.primary_hit ? 1 : 0,
          pct: r.pct,
          shares: r.shares,
          as_of_date: r.as_of_date,
          in_sme_universe: r.in_sme_universe ? 1 : 0,
          fetched_at: r.fetched_at,
        });
        if (info.changes > 0) n += 1;
      }
    });
    tx(rows);
    return n;
  } finally {
    db.close();
  }
}

export function upsertNewsSignals(rows: NewsSignal[]): number {
  if (!rows.length) return 0;
  const db = openDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO news_signals (
        investor_ids, query, headline, link, published, fetched_at
      ) VALUES (
        @investor_ids, @query, @headline, @link, @published, @fetched_at
      )
      ON CONFLICT(headline, link) DO UPDATE SET
        investor_ids = excluded.investor_ids,
        published = excluded.published,
        fetched_at = excluded.fetched_at
    `);
    let n = 0;
    const tx = db.transaction((batch: NewsSignal[]) => {
      for (const r of batch) {
        const info = stmt.run({
          investor_ids: r.investor_ids.join(","),
          query: r.query,
          headline: r.headline,
          link: r.link,
          published: r.published,
          fetched_at: r.fetched_at,
        });
        if (info.changes > 0) n += 1;
      }
    });
    tx(rows);
    return n;
  } finally {
    db.close();
  }
}

export type StoredShareholdingHit = ShareholdingHit & { id: number };
export type StoredNewsSignal = NewsSignal & { id: number };

type DbShareholdingRow = {
  id: number;
  symbol: string;
  company_name: string | null;
  holder_name: string;
  investor_ids: string;
  primary_hit: number;
  pct: number | null;
  shares: number | null;
  as_of_date: string | null;
  in_sme_universe: number;
  fetched_at: string;
};

export function listShareholdingHits(opts?: {
  primaryOnly?: boolean;
  smeOnly?: boolean;
  limit?: number;
}): StoredShareholdingHit[] {
  const db = openDb();
  try {
    let sql = `SELECT * FROM shareholding_hits WHERE 1=1`;
    const params: unknown[] = [];
    if (opts?.primaryOnly) {
      sql += ` AND primary_hit = 1`;
    }
    if (opts?.smeOnly) {
      sql += ` AND in_sme_universe = 1`;
    }
    sql += ` ORDER BY fetched_at DESC LIMIT ?`;
    params.push(Math.min(opts?.limit ?? 100, 500));

    return (db.prepare(sql).all(...params) as DbShareholdingRow[]).map(
      (r) => ({
        id: r.id,
        symbol: r.symbol,
        company_name: r.company_name,
        holder_name: r.holder_name,
        investor_ids: r.investor_ids.split(",").filter(Boolean),
        primary_hit: r.primary_hit === 1,
        pct: r.pct,
        shares: r.shares,
        as_of_date: r.as_of_date,
        in_sme_universe: r.in_sme_universe === 1,
        fetched_at: r.fetched_at,
      }),
    );
  } finally {
    db.close();
  }
}

export function listNewsSignals(opts?: {
  primaryOnly?: boolean;
  limit?: number;
}): StoredNewsSignal[] {
  const db = openDb();
  try {
    const limit = Math.min(opts?.limit ?? 50, 200);
    const rows = db
      .prepare(
        `SELECT * FROM news_signals ORDER BY fetched_at DESC LIMIT ?`,
      )
      .all(limit) as Array<
      NewsSignal & { id: number; investor_ids: string }
    >;

    let out = rows.map((r) => ({
      id: r.id,
      investor_ids: r.investor_ids.split(",").filter(Boolean),
      query: r.query,
      headline: r.headline,
      link: r.link,
      published: r.published,
      fetched_at: r.fetched_at,
    }));

    if (opts?.primaryOnly) {
      out = out.filter((r) =>
        r.investor_ids.some((id) => id === "trilithon" || id === "devabhaktuni"),
      );
    }
    return out;
  } finally {
    db.close();
  }
}
