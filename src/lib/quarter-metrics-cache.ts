import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const METRICS_PATH = path.join(DATA_DIR, "metrics.db");

export type QuarterMetricsRow = {
  ticker: string;
  forward_pe: number | null;
  eps_yoy: number | null;
  sales_yoy: number | null;
  np_yoy: number | null;
  computed_at: string;
};

let cacheDb: Database.Database | null = null;
let mapCache: { at: number; map: Map<string, QuarterMetricsRow> } | null =
  null;
const MAP_CACHE_MS = 5_000;
/** Re-fetch quarter metrics after this (new results season). */
export const QUARTER_METRICS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function ensureDb(): Database.Database {
  if (cacheDb) return cacheDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(METRICS_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS quarter_metrics (
      ticker TEXT PRIMARY KEY,
      forward_pe REAL,
      eps_yoy REAL,
      sales_yoy REAL,
      np_yoy REAL,
      computed_at TEXT NOT NULL
    );
  `);
  cacheDb = db;
  return db;
}

export function invalidateQuarterMetricsCache(): void {
  mapCache = null;
}

export function loadQuarterMetricsMap(): Map<string, QuarterMetricsRow> {
  const now = Date.now();
  if (mapCache && now - mapCache.at < MAP_CACHE_MS) {
    return mapCache.map;
  }
  const map = new Map<string, QuarterMetricsRow>();
  try {
    if (!fs.existsSync(METRICS_PATH)) {
      mapCache = { at: now, map };
      return map;
    }
    const db = ensureDb();
    const rows = db
      .prepare(
        `SELECT ticker, forward_pe, eps_yoy, sales_yoy, np_yoy, computed_at
         FROM quarter_metrics`,
      )
      .all() as QuarterMetricsRow[];
    for (const r of rows) map.set(r.ticker.toUpperCase(), r);
  } catch {
    /* unreadable */
  }
  mapCache = { at: now, map };
  return map;
}

/** All three metric dots green: Fwd PE ≤20, EPS YoY >0, Sales YoY >0. */
export function isAllGreenMetrics(
  row: Pick<
    QuarterMetricsRow,
    "forward_pe" | "eps_yoy" | "sales_yoy"
  > | null | undefined,
): boolean {
  if (!row) return false;
  const pe = row.forward_pe;
  if (pe == null || !Number.isFinite(pe) || pe <= 0 || pe >= 500 || pe > 20) {
    return false;
  }
  if (row.eps_yoy == null || !Number.isFinite(row.eps_yoy) || row.eps_yoy <= 0) {
    return false;
  }
  if (
    row.sales_yoy == null ||
    !Number.isFinite(row.sales_yoy) ||
    row.sales_yoy <= 0
  ) {
    return false;
  }
  return true;
}

export function saveQuarterMetrics(
  ticker: string,
  data: {
    forward_pe: number | null;
    eps_yoy: number | null;
    sales_yoy: number | null;
    np_yoy: number | null;
  },
): void {
  const key = ticker.toUpperCase();
  const db = ensureDb();
  db.prepare(
    `INSERT INTO quarter_metrics (ticker, forward_pe, eps_yoy, sales_yoy, np_yoy, computed_at)
     VALUES (@ticker, @forward_pe, @eps_yoy, @sales_yoy, @np_yoy, @computed_at)
     ON CONFLICT(ticker) DO UPDATE SET
       forward_pe = excluded.forward_pe,
       eps_yoy = excluded.eps_yoy,
       sales_yoy = excluded.sales_yoy,
       np_yoy = excluded.np_yoy,
       computed_at = excluded.computed_at`,
  ).run({
    ticker: key,
    forward_pe: data.forward_pe,
    eps_yoy: data.eps_yoy,
    sales_yoy: data.sales_yoy,
    np_yoy: data.np_yoy,
    computed_at: new Date().toISOString(),
  });
  invalidateQuarterMetricsCache();
}

export function isQuarterMetricsCached(
  row: QuarterMetricsRow | undefined,
): boolean {
  return !!row?.computed_at;
}

export function isQuarterMetricsFresh(
  row: QuarterMetricsRow | undefined,
  maxAgeMs = QUARTER_METRICS_TTL_MS,
): boolean {
  if (!row?.computed_at) return false;
  const t = Date.parse(row.computed_at);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < maxAgeMs;
}

/** Tickers never scanned yet (includes failed / no-data tombstones). */
export function tickerNeedsQuarterScan(
  ticker: string,
  map = loadQuarterMetricsMap(),
): boolean {
  return !map.has(ticker.toUpperCase());
}
