/**
 * SQLite cache for distress scores (avoid re-hitting Yahoo on every load).
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { DistressScoreResult } from "./score";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "distress_cache.db");
const TTL_MS = 24 * 60 * 60 * 1000;

function openDb(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS distress_scores (
      ticker TEXT PRIMARY KEY,
      distress_score REAL NOT NULL,
      distress_flags TEXT NOT NULL,
      distress_reason TEXT,
      drawdown_pct REAL,
      bounce_pct REAL,
      eps_yoy REAL,
      sales_yoy REAL,
      pe REAL,
      mcap_cr REAL,
      price REAL,
      returns_pct REAL,
      fetched_at TEXT NOT NULL
    );
  `);
  return db;
}

export function upsertDistressScores(rows: DistressScoreResult[]): void {
  const db = openDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO distress_scores (
        ticker, distress_score, distress_flags, distress_reason,
        drawdown_pct, bounce_pct, eps_yoy, sales_yoy, pe, mcap_cr, price,
        returns_pct, fetched_at
      ) VALUES (
        @ticker, @distress_score, @distress_flags, @distress_reason,
        @drawdown_pct, @bounce_pct, @eps_yoy, @sales_yoy, @pe, @mcap_cr, @price,
        @returns_pct, @fetched_at
      )
      ON CONFLICT(ticker) DO UPDATE SET
        distress_score = excluded.distress_score,
        distress_flags = excluded.distress_flags,
        distress_reason = excluded.distress_reason,
        drawdown_pct = excluded.drawdown_pct,
        bounce_pct = excluded.bounce_pct,
        eps_yoy = excluded.eps_yoy,
        sales_yoy = excluded.sales_yoy,
        pe = excluded.pe,
        mcap_cr = excluded.mcap_cr,
        price = excluded.price,
        returns_pct = excluded.returns_pct,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((batch: DistressScoreResult[]) => {
      for (const r of batch) {
        stmt.run({
          ticker: r.metrics.ticker,
          distress_score: r.distress_score,
          distress_flags: r.distress_flags.join(","),
          distress_reason: r.distress_reason,
          drawdown_pct: r.metrics.drawdown_pct,
          bounce_pct: r.metrics.bounce_pct,
          eps_yoy: r.metrics.eps_yoy,
          sales_yoy: r.metrics.sales_yoy,
          pe: r.metrics.pe,
          mcap_cr: r.metrics.mcap_cr,
          price: r.metrics.price,
          returns_pct: r.metrics.returns_pct,
          fetched_at: new Date().toISOString(),
        });
      }
    });
    tx(rows);
  } finally {
    db.close();
  }
}

export type CachedDistressRow = {
  ticker: string;
  distress_score: number;
  distress_flags: string[];
  distress_reason: string | null;
  drawdown_pct: number | null;
  bounce_pct: number | null;
  eps_yoy: number | null;
  sales_yoy: number | null;
  pe: number | null;
  mcap_cr: number | null;
  price: number | null;
  returns_pct: number | null;
  fetched_at: string;
};

export function getCachedDistress(ticker: string): CachedDistressRow | null {
  const db = openDb();
  try {
    const row = db
      .prepare(`SELECT * FROM distress_scores WHERE ticker = ?`)
      .get(ticker.toUpperCase()) as
      | (CachedDistressRow & { distress_flags: string })
      | undefined;
    if (!row) return null;
    const age = Date.now() - new Date(row.fetched_at).getTime();
    if (age > TTL_MS) return null;
    return {
      ...row,
      distress_flags: row.distress_flags.split(",").filter(Boolean),
    };
  } finally {
    db.close();
  }
}

export function listCachedDistress(
  tickers: string[],
  opts?: { minScore?: number },
): CachedDistressRow[] {
  const minScore = opts?.minScore ?? 0;
  const db = openDb();
  try {
    const cutoff = new Date(Date.now() - TTL_MS).toISOString();
    const out: CachedDistressRow[] = [];
    const stmt = db.prepare(
      `SELECT * FROM distress_scores WHERE ticker = ? AND fetched_at >= ?`,
    );
    for (const raw of tickers) {
      const ticker = raw.toUpperCase();
      const row = stmt.get(ticker, cutoff) as
        | (CachedDistressRow & { distress_flags: string })
        | undefined;
      if (!row || row.distress_score < minScore) continue;
      out.push({
        ...row,
        distress_flags: row.distress_flags.split(",").filter(Boolean),
      });
    }
    return out.sort((a, b) => b.distress_score - a.distress_score);
  } finally {
    db.close();
  }
}

/** Tickers with no fresh cache row (missing or expired). */
export function tickersNeedingDistressScan(
  tickers: string[],
  limit: number,
): string[] {
  const db = openDb();
  try {
    const cutoff = new Date(Date.now() - TTL_MS).toISOString();
    const stmt = db.prepare(
      `SELECT fetched_at FROM distress_scores WHERE ticker = ?`,
    );
    const out: string[] = [];
    for (const raw of tickers) {
      if (out.length >= limit) break;
      const ticker = raw.toUpperCase();
      const row = stmt.get(ticker) as { fetched_at: string } | undefined;
      if (!row || row.fetched_at < cutoff) out.push(ticker);
    }
    return out;
  } finally {
    db.close();
  }
}

export function countFreshDistressCache(tickers: string[]): number {
  const db = openDb();
  try {
    const cutoff = new Date(Date.now() - TTL_MS).toISOString();
    const stmt = db.prepare(
      `SELECT 1 FROM distress_scores WHERE ticker = ? AND fetched_at >= ?`,
    );
    let n = 0;
    for (const raw of tickers) {
      if (stmt.get(raw.toUpperCase(), cutoff)) n += 1;
    }
    return n;
  } finally {
    db.close();
  }
}

export function distressTickerSetFromCache(): Set<string> {
  const db = openDb();
  try {
    const cutoff = new Date(Date.now() - TTL_MS).toISOString();
    const rows = db
      .prepare(
        `SELECT ticker FROM distress_scores WHERE fetched_at >= ? AND distress_score > 0`,
      )
      .all(cutoff) as Array<{ ticker: string }>;
    return new Set(rows.map((r) => r.ticker.toUpperCase()));
  } finally {
    db.close();
  }
}
