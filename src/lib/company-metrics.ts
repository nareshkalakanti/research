/**
 * company_metrics on governance.db: changing market/financial data, kept apart
 * from companies (identity). Filled only from local caches; missing stays NULL.
 */
import type Database from "better-sqlite3";
import { loadMetricsMap } from "@/lib/metrics";
import { loadNapkinStockScan, loadPeByTicker } from "@/lib/napkin/stock-scan";

/**
 * market_cap is ₹ Cr. CAGR columns are ratios (0.15 = 15%). roce/roe are
 * percent points as stored on the Screener series.
 */
export const COMPANY_METRICS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS company_metrics (
    ticker TEXT PRIMARY KEY REFERENCES companies(ticker)
        ON DELETE CASCADE,
    market_cap REAL,
    pe REAL,
    revenue_cagr_3y REAL,
    revenue_cagr_5y REAL,
    eps_cagr_3y REAL,
    eps_cagr_5y REAL,
    roce REAL,
    roe REAL,
    current_price REAL,
    updated_at TEXT NOT NULL
)`;

const SYNC_MAX_AGE_MS = 60 * 60 * 1000;

function finite(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function positive(v: number | null | undefined): number | null {
  const n = finite(v);
  return n != null && n > 0 ? n : null;
}

export function ensureCompanyMetricsTable(db: Database.Database): void {
  db.exec(COMPANY_METRICS_TABLE_SQL);
}

/** Rebuild company_metrics for every ticker in companies. Returns rows written. */
export function syncCompanyMetrics(db: Database.Database): number {
  ensureCompanyMetricsTable(db);
  const tickers = (
    db.prepare(`SELECT ticker FROM companies`).all() as Array<{ ticker: string }>
  ).map((r) => r.ticker);
  const quotes = loadMetricsMap();
  const scan = new Map(
    loadNapkinStockScan("any").rows.map((r) => [r.ticker.toUpperCase(), r]),
  );
  const pes = loadPeByTicker();
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO company_metrics (
       ticker, market_cap, pe, revenue_cagr_3y, revenue_cagr_5y,
       eps_cagr_3y, eps_cagr_5y, roce, roe, current_price, updated_at
     ) VALUES (
       @ticker, @market_cap, @pe, @revenue_cagr_3y, @revenue_cagr_5y,
       @eps_cagr_3y, @eps_cagr_5y, @roce, NULL, @current_price, @updated_at
     )
     ON CONFLICT(ticker) DO UPDATE SET
       market_cap = excluded.market_cap,
       pe = excluded.pe,
       revenue_cagr_3y = excluded.revenue_cagr_3y,
       revenue_cagr_5y = excluded.revenue_cagr_5y,
       eps_cagr_3y = excluded.eps_cagr_3y,
       eps_cagr_5y = excluded.eps_cagr_5y,
       roce = excluded.roce,
       current_price = excluded.current_price,
       updated_at = excluded.updated_at`,
  );
  const run = db.transaction(() => {
    let n = 0;
    for (const ticker of tickers) {
      const key = ticker.toUpperCase();
      const q = quotes.get(key);
      const s = scan.get(key);
      upsert.run({
        ticker,
        market_cap: positive(q?.market_cap_cr ?? s?.market_cap_cr),
        pe: finite(s?.pe ?? pes.get(key)),
        revenue_cagr_3y: finite(s?.revenue_cagr_3y),
        revenue_cagr_5y: finite(s?.revenue_cagr_5y),
        eps_cagr_3y: finite(s?.eps_3y),
        eps_cagr_5y: finite(s?.eps_5y),
        roce: finite(s?.roce),
        current_price: positive(q?.price ?? s?.price),
        updated_at: now,
      });
      n += 1;
    }
    return n;
  });
  return run();
}

/** Sync when the table is empty or older than an hour (or when forced). */
export function ensureCompanyMetricsFresh(
  db: Database.Database,
  force = false,
): void {
  ensureCompanyMetricsTable(db);
  if (!force) {
    const row = db
      .prepare(`SELECT MAX(updated_at) AS at, COUNT(*) AS n FROM company_metrics`)
      .get() as { at: string | null; n: number };
    const age = row.at ? Date.now() - Date.parse(row.at) : Infinity;
    if (row.n > 0 && age < SYNC_MAX_AGE_MS) return;
  }
  syncCompanyMetrics(db);
}
