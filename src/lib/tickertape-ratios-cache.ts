/**
 * Cached Tickertape ratios for 7-rule ROE/ROCE backup when Screener is thin/blocked.
 */
import { openSqliteNamed } from "./sqlite-utils";
import type { TickertapeStockRatios } from "./web-mcap";

function ensureSchema(): void {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tickertape_ratios_cache (
        ticker TEXT PRIMARY KEY,
        ratios_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}

export function writeTickertapeRatiosCache(
  ticker: string,
  ratios: TickertapeStockRatios,
): void {
  const key = ticker.trim().toUpperCase();
  if (!key) return;
  if (ratios.roe == null && ratios.roce == null) return;
  ensureSchema();
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO tickertape_ratios_cache (ticker, ratios_json, fetched_at)
       VALUES (@ticker, @ratios_json, @fetched_at)
       ON CONFLICT(ticker) DO UPDATE SET
         ratios_json = excluded.ratios_json,
         fetched_at = excluded.fetched_at`,
    ).run({
      ticker: key,
      ratios_json: JSON.stringify(ratios),
      fetched_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
  mapCache = null;
}

let mapCache: { at: number; map: Map<string, TickertapeStockRatios> } | null =
  null;
const MAP_MS = 60_000;

/** All cached Tickertape ratios (Scan 7-rule backup). */
export function loadTickertapeRatiosMap(): Map<string, TickertapeStockRatios> {
  const now = Date.now();
  if (mapCache && now - mapCache.at < MAP_MS) return mapCache.map;
  const map = new Map<string, TickertapeStockRatios>();
  try {
    ensureSchema();
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const rows = db
        .prepare(`SELECT ticker, ratios_json FROM tickertape_ratios_cache`)
        .all() as Array<{ ticker: string; ratios_json: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.ratios_json) as TickertapeStockRatios;
          map.set(row.ticker.toUpperCase(), parsed);
        } catch {
          /* skip */
        }
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
