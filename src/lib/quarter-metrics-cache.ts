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
  sales_qoq: number | null;
  np_qoq: number | null;
  eps_qoq: number | null;
  ebidt_yoy: number | null;
  cf_profit: number | null;
  computed_at: string;
};

export type QuarterMetricsExtras = Pick<
  QuarterMetricsRow,
  | "sales_qoq"
  | "np_qoq"
  | "eps_qoq"
  | "ebidt_yoy"
  | "cf_profit"
>;

let cacheDb: Database.Database | null = null;
let mapCache: { at: number; map: Map<string, QuarterMetricsRow> } | null =
  null;
const MAP_CACHE_MS = 5_000;
/** Re-fetch quarter metrics after this (new results season). */
export const QUARTER_METRICS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Retry failed (empty) fetches sooner than successful cache rows. */
export const QUARTER_TOMBSTONE_TTL_MS = 60 * 60 * 1000;

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
      sales_qoq REAL,
      np_qoq REAL,
      eps_qoq REAL,
      ebidt_yoy REAL,
      cf_profit REAL,
      computed_at TEXT NOT NULL
    );
  `);
  const cols = db
    .prepare(`PRAGMA table_info(quarter_metrics)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  for (const col of [
    "sales_qoq",
    "np_qoq",
    "eps_qoq",
    "ebidt_yoy",
    "cf_profit",
  ]) {
    if (!names.has(col)) {
      db.exec(`ALTER TABLE quarter_metrics ADD COLUMN ${col} REAL`);
    }
  }
  cacheDb = db;
  return db;
}

export function invalidateQuarterMetricsCache(): void {
  mapCache = null;
}

/** Drop empty failed-fetch rows so the next open refetches immediately. */
export function purgeQuarterMetricTombstones(): number {
  try {
    if (!fs.existsSync(METRICS_PATH)) return 0;
    const db = ensureDb();
    const result = db
      .prepare(
        `DELETE FROM quarter_metrics
         WHERE forward_pe IS NULL
           AND eps_yoy IS NULL
           AND sales_yoy IS NULL
           AND np_yoy IS NULL`,
      )
      .run();
    invalidateQuarterMetricsCache();
    return result.changes;
  } catch {
    return 0;
  }
}

const TOMBSTONE_HEAL_VERSION = 1;
let tombstonesHealed = false;

function healStoredTombstonesOnce(): void {
  if (tombstonesHealed) return;
  tombstonesHealed = true;
  try {
    const db = ensureDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS quarter_metrics_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const row = db
      .prepare(`SELECT value FROM quarter_metrics_meta WHERE key = 'tombstone_heal_v'`)
      .get() as { value: string } | undefined;
    const done = Number(row?.value) >= TOMBSTONE_HEAL_VERSION;
    if (!done) {
      purgeQuarterMetricTombstones();
      db.prepare(
        `INSERT INTO quarter_metrics_meta (key, value) VALUES ('tombstone_heal_v', @v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run({ v: String(TOMBSTONE_HEAL_VERSION) });
    }
  } catch {
    purgeQuarterMetricTombstones();
  }
}

export function loadQuarterMetricsMap(): Map<string, QuarterMetricsRow> {
  healStoredTombstonesOnce();
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
        `SELECT ticker, forward_pe, eps_yoy, sales_yoy, np_yoy,
                sales_qoq, np_qoq, eps_qoq, ebidt_yoy, cf_profit, computed_at
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

export function saveQuarterMetrics(
  ticker: string,
  data: {
    forward_pe: number | null;
    eps_yoy: number | null;
    sales_yoy: number | null;
    np_yoy: number | null;
    sales_qoq?: number | null;
    np_qoq?: number | null;
    eps_qoq?: number | null;
    ebidt_yoy?: number | null;
    cf_profit?: number | null;
  },
): void {
  const key = ticker.toUpperCase();
  const db = ensureDb();
  db.prepare(
    `INSERT INTO quarter_metrics (
       ticker, forward_pe, eps_yoy, sales_yoy, np_yoy,
       sales_qoq, np_qoq, eps_qoq, ebidt_yoy, cf_profit, computed_at
     )
     VALUES (
       @ticker, @forward_pe, @eps_yoy, @sales_yoy, @np_yoy,
       @sales_qoq, @np_qoq, @eps_qoq, @ebidt_yoy, @cf_profit, @computed_at
     )
     ON CONFLICT(ticker) DO UPDATE SET
       forward_pe = excluded.forward_pe,
       eps_yoy = excluded.eps_yoy,
       sales_yoy = excluded.sales_yoy,
       np_yoy = excluded.np_yoy,
       sales_qoq = excluded.sales_qoq,
       np_qoq = excluded.np_qoq,
       eps_qoq = excluded.eps_qoq,
       ebidt_yoy = excluded.ebidt_yoy,
       cf_profit = excluded.cf_profit,
       computed_at = excluded.computed_at`,
  ).run({
    ticker: key,
    forward_pe: data.forward_pe,
    eps_yoy: data.eps_yoy,
    sales_yoy: data.sales_yoy,
    np_yoy: data.np_yoy,
    sales_qoq: data.sales_qoq ?? null,
    np_qoq: data.np_qoq ?? null,
    eps_qoq: data.eps_qoq ?? null,
    ebidt_yoy: data.ebidt_yoy ?? null,
    cf_profit: data.cf_profit ?? null,
    computed_at: new Date().toISOString(),
  });
  invalidateQuarterMetricsCache();
}

export function extrasFromMetricsRow(
  row: QuarterMetricsRow | null | undefined,
): QuarterMetricsExtras | null {
  if (!row) return null;
  const extras: QuarterMetricsExtras = {
    sales_qoq: row.sales_qoq,
    np_qoq: row.np_qoq,
    eps_qoq: row.eps_qoq,
    ebidt_yoy: row.ebidt_yoy,
    cf_profit: row.cf_profit,
  };
  if (
    extras.sales_qoq == null &&
    extras.np_qoq == null &&
    extras.eps_qoq == null &&
    extras.ebidt_yoy == null &&
    extras.cf_profit == null
  ) {
    return null;
  }
  return extras;
}

export function isQuarterMetricsCached(
  row: QuarterMetricsRow | undefined,
): boolean {
  return !!row?.computed_at;
}

/** Row saved when Yahoo/NSE returned no usable quarter panel. */
export function isQuarterMetricsTombstone(
  row: QuarterMetricsRow | undefined,
): boolean {
  if (!row?.computed_at) return false;
  return (
    row.forward_pe == null &&
    row.eps_yoy == null &&
    row.sales_yoy == null &&
    row.np_yoy == null
  );
}

export function isQuarterMetricsFresh(
  row: QuarterMetricsRow | undefined,
  maxAgeMs = QUARTER_METRICS_TTL_MS,
): boolean {
  if (!row?.computed_at) return false;
  const t = Date.parse(row.computed_at);
  if (!Number.isFinite(t)) return false;
  const ttl = isQuarterMetricsTombstone(row)
    ? Math.min(maxAgeMs, QUARTER_TOMBSTONE_TTL_MS)
    : maxAgeMs;
  return Date.now() - t < ttl;
}

/** Tickers never scanned yet (includes failed / no-data tombstones). */
export function tickerNeedsQuarterScan(
  ticker: string,
  map = loadQuarterMetricsMap(),
): boolean {
  return !map.has(ticker.toUpperCase());
}

/** Scanned rows missing QoQ / EBIDT / CF columns (pre-migration cache). */
export function tickerNeedsExtrasBackfill(
  ticker: string,
  map = loadQuarterMetricsMap(),
): boolean {
  const row = map.get(ticker.toUpperCase());
  if (!row) return false;
  return (
    row.sales_qoq == null &&
    row.np_qoq == null &&
    row.eps_qoq == null &&
    row.ebidt_yoy == null &&
    row.cf_profit == null
  );
}

export function tickerNeedsMetricsRefresh(
  ticker: string,
  map = loadQuarterMetricsMap(),
): boolean {
  return (
    tickerNeedsQuarterScan(ticker, map) ||
    tickerNeedsExtrasBackfill(ticker, map)
  );
}
