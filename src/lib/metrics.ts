import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fetchLivePrices, type YfQuote } from "./yfinance";
import {
  BSE_SME_MARKET,
  fetchBseSmeMetrics,
  loadBseSmeCacheMap,
} from "./bse-sme";

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

const METRICS_SCHEMA = `
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
`;

function isSqliteCorrupt(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "SQLITE_CORRUPT"
  );
}

function closeMetricsDb(): void {
  if (!metricsDb) return;
  try {
    metricsDb.close();
  } catch {
    /* already closed */
  }
  metricsDb = null;
}

/** Drop open handle + in-memory map (after Yahoo fill or corruption recovery). */
export function invalidateMetricsDb(): void {
  closeMetricsDb();
  metricsMapCache = null;
}

export function invalidateMetricsCache(): void {
  metricsMapCache = null;
}

/** Recreate metrics.db when the on-disk image is malformed. */
function resetMetricsDb(): void {
  invalidateMetricsDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = METRICS_PATH + suffix;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* another process may still hold the inode */
    }
  }
}

function ensureMetricsDb(): Database.Database {
  if (metricsDb) return metricsDb;

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(METRICS_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(METRICS_SCHEMA);
  metricsDb = db;
  return db;
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

/** Refresh cached page prices when older than this (ms). */
export const PAGE_PRICE_MAX_AGE_MS = 5 * 60 * 1000;

function metricsNeedsPriceRefresh(
  row: MetricsRow | undefined,
  maxAgeMs: number,
): boolean {
  if (!row || row.price == null) return true;
  const t = Date.parse(row.fetched_at);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > maxAgeMs;
}

/** Pull live Yahoo quotes for visible rows and upsert into metrics.db. */
export async function refreshPagePrices(
  items: Array<{ ticker: string; market?: string | null }>,
  opts?: { force?: boolean; maxAgeMs?: number; concurrency?: number },
): Promise<number> {
  if (!items.length) return 0;

  const maxAgeMs = opts?.maxAgeMs ?? PAGE_PRICE_MAX_AGE_MS;
  const map = loadMetricsMap();
  const pending = items.filter((c) => {
    if (opts?.force) return true;
    return metricsNeedsPriceRefresh(map.get(c.ticker.toUpperCase()), maxAgeMs);
  });
  if (!pending.length) return 0;

  try {
    const quotes = await fetchLivePrices(pending, {
      concurrency: opts?.concurrency ?? 8,
    });
    const marketBy: Record<string, string> = {};
    for (const c of pending) {
      marketBy[c.ticker.toUpperCase()] = c.market ?? "";
    }
    return upsertMetrics(quotes, marketBy);
  } catch (err) {
    console.warn("[metrics] refreshPagePrices failed:", err);
    return 0;
  }
}

export function upsertMetrics(
  quotes: YfQuote[],
  marketByTicker?: Record<string, string | null | undefined>,
  retry = true,
): number {
  if (!quotes.length) return 0;
  const now = new Date().toISOString();

  try {
    const db = ensureMetricsDb();
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
  } catch (err) {
    if (retry && isSqliteCorrupt(err)) {
      console.warn("[metrics] corrupt db — recreating metrics.db");
      resetMetricsDb();
      return upsertMetrics(quotes, marketByTicker, false);
    }
    throw err;
  }
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

/** Seed mcap from cached BSE list API (fast, no live calls). */
export function seedBseSmeMcapFromCache(
  tickers?: Iterable<string>,
): number {
  const cache = loadBseSmeCacheMap();
  if (!cache.size) return 0;

  const want =
    tickers == null
      ? null
      : new Set([...tickers].map((t) => t.toUpperCase()));

  const quotes: YfQuote[] = [];
  for (const [ticker, row] of cache) {
    if (want && !want.has(ticker)) continue;
    if (row.mcap_cr == null || row.mcap_cr <= 0) continue;
    quotes.push({
      ticker,
      yf_symbol: row.scrip_code ? `BSE:${row.scrip_code}` : `${ticker}.BO`,
      price: null,
      mcap_cr: row.mcap_cr,
      sector: null,
    });
  }
  if (!quotes.length) return 0;

  const marketBy: Record<string, string> = {};
  for (const q of quotes) marketBy[q.ticker] = BSE_SME_MARKET;
  return upsertMetrics(quotes, marketBy);
}

/** Fill remaining BSE SME price/mcap gaps from BSE live APIs. */
export async function fillBseSmeMetricsGaps(
  items: Array<{ ticker: string; market?: string | null }>,
  opts?: { concurrency?: number; delayMs?: number },
): Promise<{ saved: number; filledPrice: number; filledMcap: number }> {
  const map = loadMetricsMap();
  const cache = loadBseSmeCacheMap();
  const pending = items.filter((c) => {
    if ((c.market || "").toUpperCase() !== BSE_SME_MARKET) return false;
    if (!cache.has(c.ticker.toUpperCase())) return false;
    const m = map.get(c.ticker.toUpperCase());
    return !m || m.price == null || m.market_cap_cr == null;
  });

  const concurrency = Math.max(1, opts?.concurrency ?? 4);
  const delayMs = opts?.delayMs ?? 120;
  const quotes: YfQuote[] = [];
  let next = 0;

  async function worker() {
    while (next < pending.length) {
      const item = pending[next++]!;
      const have = map.get(item.ticker.toUpperCase());
      const q = await fetchBseSmeMetrics(item.ticker, {
        needPrice: have?.price == null,
        needMcap: have?.market_cap_cr == null,
      });
      if (q && (q.price != null || q.mcap_cr != null)) {
        quotes.push({
          ticker: q.ticker,
          yf_symbol: q.yf_symbol,
          price: q.price,
          mcap_cr: q.mcap_cr,
          sector: null,
        });
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const marketBy: Record<string, string> = {};
  for (const c of pending) marketBy[c.ticker.toUpperCase()] = BSE_SME_MARKET;

  let filledPrice = 0;
  let filledMcap = 0;
  for (const q of quotes) {
    if (q.price != null) filledPrice += 1;
    if (q.mcap_cr != null) filledMcap += 1;
  }

  return {
    saved: upsertMetrics(quotes, marketBy),
    filledPrice,
    filledMcap,
  };
}
