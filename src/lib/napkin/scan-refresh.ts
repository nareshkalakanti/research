/**
 * Fill missing scanner P/E from Yahoo quotes already used for current levels.
 * Does not recompute CAGR, required EPS CAGR, or ROCE.
 */
import { upsertMetrics } from "@/lib/metrics";
import { openSqliteNamed } from "@/lib/sqlite-utils";
import { runConcurrent } from "@/lib/scrape-pool";
import { fetchQuotePe } from "@/lib/yfinance";
import {
  DEFAULT_NAPKIN_SCAN_FILTER,
  orderTickersForPeScan,
} from "./scan-filters";

const BATCH = 16;
const CONCURRENCY = 4;

type Sqlite = ReturnType<typeof openSqliteNamed>;

function ensureQuotes(db: Sqlite): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS napkin_scan_quotes (
      ticker TEXT PRIMARY KEY,
      pe_ratio REAL,
      fetched_at TEXT NOT NULL
    );
  `);
}

function annualTickers(db: Sqlite): string[] {
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'screener_annual_cache'`,
    )
    .get();
  if (!exists) return [];
  const rows = db.prepare(`SELECT ticker FROM screener_annual_cache`).all() as Array<{
    ticker: string;
  }>;
  return rows.map((row) => (row.ticker || "").trim().toUpperCase()).filter(Boolean);
}

function marketByTicker(db: Sqlite): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stock_metrics'`,
    )
    .get();
  if (!exists) return map;
  const rows = db
    .prepare(`SELECT ticker, market FROM stock_metrics`)
    .all() as Array<{
    ticker: string;
    market: string | null;
  }>;
  for (const row of rows) {
    map.set((row.ticker || "").trim().toUpperCase(), row.market);
  }
  return map;
}

function mcapByTicker(db: Sqlite): Map<string, number> {
  const map = new Map<string, number>();
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stock_metrics'`,
    )
    .get();
  if (!exists) return map;
  const rows = db
    .prepare(`SELECT ticker, market_cap_cr FROM stock_metrics`)
    .all() as Array<{ ticker: string; market_cap_cr: number | null }>;
  for (const row of rows) {
    const m = row.market_cap_cr;
    if (typeof m !== "number" || !Number.isFinite(m)) continue;
    map.set((row.ticker || "").trim().toUpperCase(), m);
  }
  return map;
}

/** Tickers that already have a P/E, or were already asked and Yahoo had none. */
function seenTickers(db: Sqlite): Set<string> {
  const seen = new Set<string>();
  ensureQuotes(db);
  const scanned = db
    .prepare(`SELECT ticker FROM napkin_scan_quotes`)
    .all() as Array<{ ticker: string }>;
  for (const row of scanned) seen.add((row.ticker || "").trim().toUpperCase());
  const pead = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pead_web_metrics'`,
    )
    .get();
  if (!pead) return seen;
  const rows = db
    .prepare(
      `SELECT ticker FROM pead_web_metrics WHERE pe_ratio IS NOT NULL`,
    )
    .all() as Array<{ ticker: string }>;
  for (const row of rows) {
    seen.add((row.ticker || "").trim().toUpperCase());
  }
  return seen;
}

function saveQuotes(
  db: Sqlite,
  rows: Array<{ ticker: string; pe: number | null }>,
): void {
  ensureQuotes(db);
  const stmt = db.prepare(
    `INSERT INTO napkin_scan_quotes (ticker, pe_ratio, fetched_at)
     VALUES (@ticker, @pe_ratio, @fetched_at)
     ON CONFLICT(ticker) DO UPDATE SET
       pe_ratio = excluded.pe_ratio,
       fetched_at = excluded.fetched_at`,
  );
  const now = new Date().toISOString();
  const tx = db.transaction((items: Array<{ ticker: string; pe: number | null }>) => {
    for (const item of items) {
      stmt.run({
        ticker: item.ticker,
        pe_ratio: item.pe,
        fetched_at: now,
      });
    }
  });
  tx(rows);
}

export type NapkinPeScanBatch = {
  tried: number;
  pe_found: number;
  remaining: number;
  done: boolean;
  stalled: boolean;
};

function openMetrics(): Sqlite {
  return openSqliteNamed("metrics.db", { readonly: false, wal: true });
}

/**
 * Yahoo P/E for the given tickers (trailing, then forward). Saves every answer,
 * including a null P/E. Returns tickers Yahoo answered and those with a P/E.
 */
export async function refreshPeForTickers(
  tickers: string[],
): Promise<{ answered: string[]; with_pe: string[] }> {
  if (!tickers.length) return { answered: [], with_pe: [] };
  const read = openMetrics();
  let markets: Map<string, string | null>;
  try {
    markets = marketByTicker(read);
  } finally {
    read.close();
  }
  const quotes = await runConcurrent(tickers, CONCURRENCY, (ticker) =>
    fetchQuotePe(ticker, markets.get(ticker) ?? null),
  );
  const answered = quotes.filter(
    (q) => q.pe != null || q.price != null || q.mcap_cr != null,
  );
  if (!answered.length) return { answered: [], with_pe: [] };
  const write = openMetrics();
  try {
    saveQuotes(
      write,
      answered.map((q) => ({ ticker: q.ticker, pe: q.pe })),
    );
  } finally {
    write.close();
  }
  upsertMetrics(
    answered
      .filter((q) => q.price != null || q.mcap_cr != null)
      .map((q) => ({
        ticker: q.ticker,
        yf_symbol: "",
        price: q.price,
        mcap_cr: q.mcap_cr,
        sector: null,
      })),
  );
  return {
    answered: answered.map((q) => q.ticker),
    with_pe: answered.filter((q) => q.pe != null).map((q) => q.ticker),
  };
}

/** One Yahoo batch. Names Yahoo does not answer stay queued for the next click. */
export async function refreshNapkinScanPeBatch(): Promise<NapkinPeScanBatch> {
  const db = openMetrics();
  let queue: string[];
  let batch: string[];
  let markets: Map<string, string | null>;
  try {
    queue = orderTickersForPeScan(
      annualTickers(db),
      seenTickers(db),
      mcapByTicker(db),
      {
        min: DEFAULT_NAPKIN_SCAN_FILTER.mcapMin ?? 0,
        max: DEFAULT_NAPKIN_SCAN_FILTER.mcapMax ?? Number.POSITIVE_INFINITY,
      },
    );
    batch = queue.slice(0, BATCH);
    markets = marketByTicker(db);
  } finally {
    db.close();
  }
  if (!queue.length) {
    return { tried: 0, pe_found: 0, remaining: 0, done: true, stalled: false };
  }
  const quotes = await runConcurrent(batch, CONCURRENCY, (ticker) =>
    fetchQuotePe(ticker, markets.get(ticker) ?? null),
  );
  const answered = quotes.filter(
    (q) => q.pe != null || q.price != null || q.mcap_cr != null,
  );
  if (!answered.length) {
    return {
      tried: batch.length,
      pe_found: 0,
      remaining: queue.length,
      done: false,
      stalled: true,
    };
  }
  const write = openMetrics();
  try {
    saveQuotes(
      write,
      answered.map((q) => ({ ticker: q.ticker, pe: q.pe })),
    );
  } finally {
    write.close();
  }
  upsertMetrics(
    answered
      .filter((q) => q.price != null || q.mcap_cr != null)
      .map((q) => ({
        ticker: q.ticker,
        yf_symbol: "",
        price: q.price,
        mcap_cr: q.mcap_cr,
        sector: null,
      })),
  );
  const pe_found = answered.filter((q) => q.pe != null).length;
  const remaining = queue.length - answered.length;
  return {
    tried: batch.length,
    pe_found,
    remaining,
    done: remaining === 0,
    stalled: false,
  };
}
