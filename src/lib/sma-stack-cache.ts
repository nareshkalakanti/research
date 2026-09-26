/**
 * Daily SMA 20/50/200 for PEAD Tech Strength — Yahoo bars, cached.
 * Not Scan EMA / TQ / 12m.
 */
import { fetchDailyBars } from "./ohlc";
import { rollingMean } from "./indicators";
import { openSqliteNamed } from "./sqlite-utils";

const CACHE_MS = 24 * 60 * 60 * 1000;

export type SmaStack = {
  price: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
};

function lastMean(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const series = rollingMean(closes, period);
  const v = series[series.length - 1];
  return v != null && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function ensureSchema(): void {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sma_stack_cache (
        ticker TEXT PRIMARY KEY,
        price REAL,
        sma20 REAL,
        sma50 REAL,
        sma200 REAL,
        fetched_at TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}

let mapCache: { at: number; map: Map<string, SmaStack> } | null = null;

export function invalidateSmaStackCache(): void {
  mapCache = null;
}

export function loadSmaStackMap(): Map<string, SmaStack> {
  const now = Date.now();
  if (mapCache && now - mapCache.at < 5_000) return mapCache.map;
  const map = new Map<string, SmaStack>();
  try {
    ensureSchema();
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const rows = db
        .prepare(
          `SELECT ticker, price, sma20, sma50, sma200, fetched_at FROM sma_stack_cache`,
        )
        .all() as Array<SmaStack & { ticker: string; fetched_at: string }>;
      for (const r of rows) {
        if (Date.now() - Date.parse(r.fetched_at) > CACHE_MS) continue;
        map.set(r.ticker.toUpperCase(), {
          price: r.price,
          sma20: r.sma20,
          sma50: r.sma50,
          sma200: r.sma200,
        });
      }
    } finally {
      db.close();
    }
  } catch {
    /* missing db */
  }
  mapCache = { at: now, map };
  return map;
}

export function smaStackTickerSet(): Set<string> {
  return new Set(loadSmaStackMap().keys());
}

function writeStack(ticker: string, stack: SmaStack): void {
  ensureSchema();
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO sma_stack_cache (ticker, price, sma20, sma50, sma200, fetched_at)
       VALUES (@ticker, @price, @sma20, @sma50, @sma200, @fetched_at)
       ON CONFLICT(ticker) DO UPDATE SET
         price = excluded.price,
         sma20 = excluded.sma20,
         sma50 = excluded.sma50,
         sma200 = excluded.sma200,
         fetched_at = excluded.fetched_at`,
    ).run({
      ticker: ticker.toUpperCase(),
      price: stack.price,
      sma20: stack.sma20,
      sma50: stack.sma50,
      sma200: stack.sma200,
      fetched_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
  invalidateSmaStackCache();
}

export async function fetchAndCacheSmaStack(
  ticker: string,
  market?: string | null,
): Promise<SmaStack | null> {
  const key = ticker.trim().toUpperCase();
  if (!key) return null;
  const bars = await fetchDailyBars(key, market, 3);
  const closes = bars.map((b) => b.close).filter((c) => Number.isFinite(c));
  const price = closes.length
    ? Math.round(closes[closes.length - 1]! * 100) / 100
    : null;
  const stack: SmaStack = {
    price,
    sma20: lastMean(closes, 20),
    sma50: lastMean(closes, 50),
    sma200: lastMean(closes, 200),
  };
  if (stack.sma20 == null && stack.sma50 == null && stack.sma200 == null) {
    return null;
  }
  writeStack(key, stack);
  return stack;
}
