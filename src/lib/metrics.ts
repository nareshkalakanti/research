import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { YfQuote } from "./yfinance";

const DATA_DIR = path.join(process.cwd(), "data");
const METRICS_PATH = path.join(DATA_DIR, "metrics.db");

export type MetricsRow = {
  ticker: string;
  market: string | null;
  yf_symbol: string | null;
  price: number | null;
  market_cap_cr: number | null;
  sector: string | null;
  fetched_at: string;
};

let metricsDb: Database.Database | null = null;
let metricsMapCache: { at: number; map: Map<string, MetricsRow> } | null =
  null;
const MAP_CACHE_MS = 5_000;

function ensureMetricsDb(): Database.Database {
  if (metricsDb) return metricsDb;

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(METRICS_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_metrics (
      ticker TEXT PRIMARY KEY,
      market TEXT,
      yf_symbol TEXT,
      price REAL,
      market_cap_cr REAL,
      sector TEXT,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_fetched ON stock_metrics(fetched_at);
  `);
  metricsDb = db;
  return db;
}

export function invalidateMetricsCache(): void {
  metricsMapCache = null;
}

export function loadMetricsMap(): Map<string, MetricsRow> {
  const now = Date.now();
  if (metricsMapCache && now - metricsMapCache.at < MAP_CACHE_MS) {
    return metricsMapCache.map;
  }

  const map = new Map<string, MetricsRow>();
  try {
    if (!fs.existsSync(METRICS_PATH)) {
      metricsMapCache = { at: now, map };
      return map;
    }
    const db = ensureMetricsDb();
    const rows = db
      .prepare(
        `SELECT ticker, market, yf_symbol, price, market_cap_cr, sector, fetched_at
         FROM stock_metrics`,
      )
      .all() as MetricsRow[];
    for (const r of rows) map.set(r.ticker.toUpperCase(), r);
  } catch {
    /* missing / unreadable cache */
  }
  metricsMapCache = { at: now, map };
  return map;
}

export function getMetrics(ticker: string): MetricsRow | undefined {
  return loadMetricsMap().get(ticker.toUpperCase());
}

export function upsertMetrics(
  quotes: YfQuote[],
  marketByTicker?: Record<string, string | null | undefined>,
): number {
  if (!quotes.length) return 0;
  const db = ensureMetricsDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO stock_metrics (ticker, market, yf_symbol, price, market_cap_cr, sector, fetched_at)
    VALUES (@ticker, @market, @yf_symbol, @price, @market_cap_cr, @sector, @fetched_at)
    ON CONFLICT(ticker) DO UPDATE SET
      market = COALESCE(excluded.market, stock_metrics.market),
      yf_symbol = COALESCE(excluded.yf_symbol, stock_metrics.yf_symbol),
      price = COALESCE(excluded.price, stock_metrics.price),
      market_cap_cr = COALESCE(excluded.market_cap_cr, stock_metrics.market_cap_cr),
      sector = COALESCE(excluded.sector, stock_metrics.sector),
      fetched_at = excluded.fetched_at
  `);

  const tx = db.transaction((rows: YfQuote[]) => {
    let n = 0;
    for (const q of rows) {
      if (q.price == null && q.mcap_cr == null) continue;
      stmt.run({
        ticker: q.ticker.toUpperCase(),
        market:
          marketByTicker?.[q.ticker] ??
          marketByTicker?.[q.ticker.toUpperCase()] ??
          null,
        yf_symbol: q.yf_symbol || null,
        price: q.price,
        market_cap_cr: q.mcap_cr,
        sector: q.sector,
        fetched_at: now,
      });
      n += 1;
    }
    return n;
  });

  const saved = tx(quotes);
  invalidateMetricsCache();
  return saved;
}

export function metricsGapCount(
  tickers: string[],
): { missingPrice: number; missingMcap: number; any: number } {
  const map = loadMetricsMap();
  let missingPrice = 0;
  let missingMcap = 0;
  let any = 0;
  for (const t of tickers) {
    const m = map.get(t.toUpperCase());
    const needP = m?.price == null;
    const needM = m?.market_cap_cr == null;
    if (needP) missingPrice += 1;
    if (needM) missingMcap += 1;
    if (needP || needM) any += 1;
  }
  return { missingPrice, missingMcap, any };
}
