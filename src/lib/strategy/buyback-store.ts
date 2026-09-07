import { openSqliteNamed } from "../sqlite-utils";
import type { LiquidityScore } from "./types";
import { loadAllCompanies } from "../db";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function ensureSchema(): void {
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS liquidity_scores (
        ticker TEXT PRIMARY KEY,
        avg_value_20d_lakh REAL,
        avg_value_60d_lakh REAL,
        avg_value_120d_lakh REAL,
        ramp_ratio REAL,
        is_low_liquidity INTEGER NOT NULL,
        is_ramping INTEGER NOT NULL,
        liquidity_score REAL NOT NULL,
        flags TEXT NOT NULL,
        reason TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strategy_scan_log (
        ticker TEXT NOT NULL,
        scan_type TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (ticker, scan_type)
      );
    `);
  } finally {
    db.close();
  }
}

export function upsertLiquidityScore(row: LiquidityScore): void {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO liquidity_scores (
         ticker, avg_value_20d_lakh, avg_value_60d_lakh, avg_value_120d_lakh,
         ramp_ratio, is_low_liquidity, is_ramping, liquidity_score, flags, reason, fetched_at
       ) VALUES (
         @ticker, @avg_value_20d_lakh, @avg_value_60d_lakh, @avg_value_120d_lakh,
         @ramp_ratio, @is_low_liquidity, @is_ramping, @liquidity_score, @flags, @reason, @fetched_at
       )
       ON CONFLICT(ticker) DO UPDATE SET
         avg_value_20d_lakh = excluded.avg_value_20d_lakh,
         avg_value_60d_lakh = excluded.avg_value_60d_lakh,
         avg_value_120d_lakh = excluded.avg_value_120d_lakh,
         ramp_ratio = excluded.ramp_ratio,
         is_low_liquidity = excluded.is_low_liquidity,
         is_ramping = excluded.is_ramping,
         liquidity_score = excluded.liquidity_score,
         flags = excluded.flags,
         reason = excluded.reason,
         fetched_at = excluded.fetched_at`,
    ).run({
      ticker: row.ticker.toUpperCase(),
      avg_value_20d_lakh: row.avg_value_20d_lakh,
      avg_value_60d_lakh: row.avg_value_60d_lakh,
      avg_value_120d_lakh: row.avg_value_120d_lakh,
      ramp_ratio: row.ramp_ratio,
      is_low_liquidity: row.is_low_liquidity ? 1 : 0,
      is_ramping: row.is_ramping ? 1 : 0,
      liquidity_score: row.liquidity_score,
      flags: row.flags.join(","),
      reason: row.reason,
      fetched_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

export function recordStrategyScan(
  ticker: string,
  scanType: "liquidity" | "concall_drift",
  status: "ok" | "empty" | "failed",
  detail?: string,
): void {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO strategy_scan_log (ticker, scan_type, status, detail, fetched_at)
       VALUES (@ticker, @scan_type, @status, @detail, @fetched_at)
       ON CONFLICT(ticker, scan_type) DO UPDATE SET
         status = excluded.status,
         detail = excluded.detail,
         fetched_at = excluded.fetched_at`,
    ).run({
      ticker: ticker.toUpperCase(),
      scan_type: scanType,
      status,
      detail: detail || null,
      fetched_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

function isFresh(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && Date.now() - ts < TTL_MS;
}

export function pendingLiquidityTickers(opts?: {
  market?: string;
  missingOnly?: boolean;
}): string[] {
  ensureSchema();
  const missingOnly = opts?.missingOnly !== false;
  const companies = loadAllCompanies();
  let filtered = companies;
  if (opts?.market && opts.market !== "All") {
    if (opts.market === "NSE") {
      filtered = companies.filter(
        (c) => c.market === "NSE" || c.market === "NSE SME",
      );
    } else {
      filtered = companies.filter((c) => c.market === opts.market);
    }
  }

  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const done = new Set<string>();
    if (missingOnly) {
      const scored = db
        .prepare(`SELECT ticker, fetched_at FROM liquidity_scores`)
        .all() as Array<{ ticker: string; fetched_at: string }>;
      for (const row of scored) {
        if (isFresh(row.fetched_at)) done.add(row.ticker.toUpperCase());
      }
      const logged = db
        .prepare(
          `SELECT ticker, fetched_at FROM strategy_scan_log WHERE scan_type = 'liquidity'`,
        )
        .all() as Array<{ ticker: string; fetched_at: string }>;
      for (const row of logged) {
        if (isFresh(row.fetched_at)) done.add(row.ticker.toUpperCase());
      }
    }
    return filtered
      .map((c) => c.ticker.toUpperCase())
      .filter((t) => !done.has(t))
      .sort();
  } finally {
    db.close();
  }
}
