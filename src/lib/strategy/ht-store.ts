import { openSqliteNamed } from "../sqlite-utils";
import type { HtCachedRow } from "./ht-types";
const CACHE_MS = 7 * 24 * 60 * 60 * 1000; // 168h ok rows
/** Soft fails (incomplete fundamentals) retry after 6h. */
const FAIL_CACHE_MS = 6 * 60 * 60 * 1000;
/** Yahoo rate-limit failures retry immediately on next Scan. */
const RATE_LIMIT_CACHE_MS = 2 * 60 * 1000;

function ensureSchema(): void {
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ht_iv_cache (
        ticker TEXT PRIMARY KEY,
        market TEXT,
        name TEXT,
        price REAL,
        market_cap_cr REAL,
        sales_growth_3y REAL,
        earnings_growth_3y REAL,
        roce_3y REAL,
        pb REAL,
        pe_ratio REAL,
        status TEXT NOT NULL,
        detail TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ht_iv_fetched ON ht_iv_cache(fetched_at);
      CREATE INDEX IF NOT EXISTS idx_ht_iv_status ON ht_iv_cache(status);
    `);
    const cols = db
      .prepare(`PRAGMA table_info(ht_iv_cache)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "earnings_growth_3y")) {
      db.exec(`ALTER TABLE ht_iv_cache ADD COLUMN earnings_growth_3y REAL`);
    }
  } finally {
    db.close();
  }
}

function isRateLimited(row: HtCachedRow): boolean {
  return /too many requests|rate.?limit|429/i.test(row.detail || "");
}

export function isHtCacheFresh(row: HtCachedRow | undefined): boolean {
  if (!row?.fetched_at) return false;
  const at = Date.parse(row.fetched_at);
  if (!Number.isFinite(at)) return false;
  const age = Date.now() - at;
  if (row.status === "ok") return age < CACHE_MS;
  if (isRateLimited(row)) return age < RATE_LIMIT_CACHE_MS;
  return age < FAIL_CACHE_MS;
}

export function upsertHtIvRow(row: HtCachedRow): void {
  upsertHtIvRows([row]);
}

export function upsertHtIvRows(rows: HtCachedRow[]): void {
  if (!rows.length) return;
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    const stmt = db.prepare(
      `INSERT INTO ht_iv_cache (
         ticker, market, name, price, market_cap_cr,
         sales_growth_3y, earnings_growth_3y, roce_3y, pb, pe_ratio,
         status, detail, fetched_at
       ) VALUES (
         @ticker, @market, @name, @price, @market_cap_cr,
         @sales_growth_3y, @earnings_growth_3y, @roce_3y, @pb, @pe_ratio,
         @status, @detail, @fetched_at
       )
       ON CONFLICT(ticker) DO UPDATE SET
         market = excluded.market,
         name = excluded.name,
         price = excluded.price,
         market_cap_cr = excluded.market_cap_cr,
         sales_growth_3y = excluded.sales_growth_3y,
         earnings_growth_3y = COALESCE(excluded.earnings_growth_3y, ht_iv_cache.earnings_growth_3y),
         roce_3y = excluded.roce_3y,
         pb = excluded.pb,
         pe_ratio = excluded.pe_ratio,
         status = excluded.status,
         detail = excluded.detail,
         fetched_at = excluded.fetched_at`,
    );
    const tx = db.transaction((batch: HtCachedRow[]) => {
      for (const row of batch) {
        stmt.run({
          ticker: row.ticker.toUpperCase(),
          market: row.market,
          name: row.name,
          price: row.price,
          market_cap_cr: row.market_cap_cr,
          sales_growth_3y: row.sales_growth_3y,
          earnings_growth_3y: row.earnings_growth_3y,
          roce_3y: row.roce_3y,
          pb: row.pb,
          pe_ratio: row.pe_ratio,
          status: row.status,
          detail: row.detail,
          fetched_at: row.fetched_at,
        });
      }
    });
    tx(rows);
  } finally {
    db.close();
  }
}

export function loadHtIvMap(): Map<string, HtCachedRow> {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const rows = db
      .prepare(
        `SELECT ticker, market, name, price, market_cap_cr,
                sales_growth_3y, earnings_growth_3y, roce_3y, pb, pe_ratio,
                status, detail, fetched_at
         FROM ht_iv_cache`,
      )
      .all() as HtCachedRow[];
    const out = new Map<string, HtCachedRow>();
    for (const r of rows) {
      out.set(r.ticker.toUpperCase(), {
        ...r,
        earnings_growth_3y: r.earnings_growth_3y ?? null,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

export function htCacheStats(tickers: string[]): {
  universe: number;
  cached_ok: number;
  pending: number;
  failed: number;
} {
  const map = loadHtIvMap();
  let cached_ok = 0;
  let failed = 0;
  let pending = 0;
  for (const t of tickers) {
    const row = map.get(t.toUpperCase());
    if (!row || !isHtCacheFresh(row)) {
      pending += 1;
      continue;
    }
    if (row.status === "ok") cached_ok += 1;
    else failed += 1;
  }
  return { universe: tickers.length, cached_ok, pending, failed };
}

/** Drop rate-limit / soft-fail rows so Scan can refill toward full universe. */
export function clearHtRetryableFailures(): number {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    const info = db
      .prepare(
        `DELETE FROM ht_iv_cache
         WHERE status != 'ok'
            OR sales_growth_3y IS NULL
            OR roce_3y IS NULL
            OR pb IS NULL`,
      )
      .run();
    return Number(info.changes ?? 0);
  } finally {
    db.close();
  }
}

export function deleteHtIvTicker(ticker: string): void {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.prepare(`DELETE FROM ht_iv_cache WHERE UPPER(ticker) = ?`).run(
      ticker.toUpperCase(),
    );
  } finally {
    db.close();
  }
}
