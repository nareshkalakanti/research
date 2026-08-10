/**
 * Forward PE — FF/PEAD style: price ÷ (latest quarter EPS × 4).
 * Stored in data/forward_pe.db for all tickers.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  computeForwardPe,
  forwardPeBand,
  PE_CHEAP_MAX,
  type ForwardPeBand,
} from "./forward-pe-band";
import { getMetrics } from "./metrics";
import { trimReportedQuarters, type QuarterPoint } from "./quarter-panel";
import { fetchQuarterlyFundamentals } from "./yahoo-quarters";

export { computeForwardPe, forwardPeBand, PE_CHEAP_MAX, type ForwardPeBand };

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "forward_pe.db");

export type ForwardPeRow = {
  ticker: string;
  market: string | null;
  forward_pe: number | null;
  latest_eps: number | null;
  quarter_end: string | null;
  price: number | null;
  fetched_at: string;
};

let cache: { at: number; map: Map<string, ForwardPeRow> } | null = null;
const CACHE_MS = 15_000;

export function latestEpsFromQuarters(
  quarters: QuarterPoint[],
): { eps: number | null; quarter_end: string | null } {
  const qs = trimReportedQuarters(
    quarters.filter((q) => q.eps != null && Number.isFinite(q.eps)),
  );
  if (!qs.length) return { eps: null, quarter_end: null };
  const last = qs[qs.length - 1]!;
  return { eps: last.eps, quarter_end: last.date };
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS forward_pe (
      ticker TEXT PRIMARY KEY,
      market TEXT,
      forward_pe REAL,
      latest_eps REAL,
      quarter_end TEXT,
      price REAL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fpe_fetched ON forward_pe(fetched_at);
  `);
}

function openWritable(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  ensureSchema(db);
  return db;
}

export function invalidateForwardPeCache(): void {
  cache = null;
}

export function loadForwardPeMap(): Map<string, ForwardPeRow> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.map;

  const map = new Map<string, ForwardPeRow>();
  if (!fs.existsSync(DB_PATH)) {
    cache = { at: now, map };
    return map;
  }
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const rows = db
      .prepare(
        `SELECT ticker, market, forward_pe, latest_eps, quarter_end, price, fetched_at
         FROM forward_pe`,
      )
      .all() as ForwardPeRow[];
    for (const r of rows) {
      map.set(String(r.ticker).toUpperCase(), {
        ...r,
        ticker: String(r.ticker).toUpperCase(),
      });
    }
  } finally {
    db.close();
  }
  cache = { at: now, map };
  return map;
}

export function forwardPeCount(map = loadForwardPeMap()): number {
  let n = 0;
  for (const r of map.values()) {
    if (r.forward_pe != null && Number.isFinite(r.forward_pe)) n += 1;
  }
  return n;
}

export function upsertForwardPe(rows: Omit<ForwardPeRow, "fetched_at">[]): number {
  if (!rows.length) return 0;
  const db = openWritable();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO forward_pe (
      ticker, market, forward_pe, latest_eps, quarter_end, price, fetched_at
    ) VALUES (
      @ticker, @market, @forward_pe, @latest_eps, @quarter_end, @price, @fetched_at
    )
    ON CONFLICT(ticker) DO UPDATE SET
      market = COALESCE(excluded.market, forward_pe.market),
      forward_pe = COALESCE(excluded.forward_pe, forward_pe.forward_pe),
      latest_eps = COALESCE(excluded.latest_eps, forward_pe.latest_eps),
      quarter_end = COALESCE(excluded.quarter_end, forward_pe.quarter_end),
      price = COALESCE(excluded.price, forward_pe.price),
      fetched_at = excluded.fetched_at
  `);
  const tx = db.transaction((batch: typeof rows) => {
    let n = 0;
    for (const r of batch) {
      if (r.forward_pe == null || !Number.isFinite(r.forward_pe)) continue;
      stmt.run({
        ticker: r.ticker.toUpperCase(),
        market: r.market,
        forward_pe: r.forward_pe,
        latest_eps: r.latest_eps,
        quarter_end: r.quarter_end,
        price: r.price,
        fetched_at: now,
      });
      n += 1;
    }
    return n;
  });
  try {
    const saved = tx(rows);
    invalidateForwardPeCache();
    return saved;
  } finally {
    db.close();
  }
}

/** Tickers with no stored forward_pe yet. */
export function missingForwardPeTickers(tickers: string[]): Set<string> {
  const map = loadForwardPeMap();
  const missing = new Set<string>();
  for (const t of tickers) {
    const key = t.toUpperCase();
    const row = map.get(key);
    if (row?.forward_pe == null || !Number.isFinite(row.forward_pe)) {
      missing.add(key);
    }
  }
  return missing;
}

export async function computeForwardPeForTicker(
  ticker: string,
  market?: string | null,
  priceHint?: number | null,
): Promise<Omit<ForwardPeRow, "fetched_at">> {
  const metrics = getMetrics(ticker);
  const knownPrice =
    (priceHint != null && priceHint > 0 ? priceHint : null) ??
    (metrics?.price != null && metrics.price > 0 ? metrics.price : null);
  const { quarters, price: yPrice } = await fetchQuarterlyFundamentals(
    ticker,
    market,
    { skipChart: knownPrice != null },
  );
  const price = knownPrice ?? yPrice;
  const { eps, quarter_end } = latestEpsFromQuarters(quarters);
  return {
    ticker: ticker.toUpperCase(),
    market: market ?? metrics?.market ?? null,
    forward_pe: computeForwardPe(price, eps),
    latest_eps: eps,
    quarter_end,
    price,
  };
}

export async function runForwardPeBatch(
  batch: Array<{ ticker: string; market?: string | null; price?: number | null }>,
  opts?: { concurrency?: number },
): Promise<{ tried: number; saved: number; failed: number }> {
  const concurrency = Math.max(1, Math.min(10, opts?.concurrency ?? 8));
  let saved = 0;
  let failed = 0;
  const out: Array<Omit<ForwardPeRow, "fetched_at">> = [];

  for (let i = 0; i < batch.length; i += concurrency) {
    const chunk = batch.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (c) => {
        try {
          return await computeForwardPeForTicker(c.ticker, c.market, c.price);
        } catch {
          failed += 1;
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) out.push(r);
    }
  }

  saved = upsertForwardPe(out);
  return { tried: batch.length, saved, failed };
}
