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
  opts?: { /** Mark that we asked Tickertape for dividend yield (even if blank). */ divChecked?: boolean },
): void {
  const key = ticker.trim().toUpperCase();
  if (!key) return;
  // Keep ROE/ROCE backups, or any Tickertape hit that includes dividend yield / price.
  if (
    ratios.roe == null &&
    ratios.roce == null &&
    ratios.div_yield == null &&
    ratios.price == null &&
    !opts?.divChecked
  ) {
    return;
  }
  ensureSchema();
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    let prev: Record<string, unknown> = {};
    try {
      const hit = db
        .prepare(`SELECT ratios_json FROM tickertape_ratios_cache WHERE ticker = ?`)
        .get(key) as { ratios_json?: string } | undefined;
      if (hit?.ratios_json) prev = JSON.parse(hit.ratios_json) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    // Prefer new non-null fields; keep prior ROE/ROCE/etc. when a fill only stamps div_checked.
    const merged: Record<string, unknown> = { ...prev };
    for (const [k, v] of Object.entries(ratios as unknown as Record<string, unknown>)) {
      if (v != null) merged[k] = v;
      else if (!(k in merged)) merged[k] = null;
    }
    if (opts?.divChecked) merged.div_checked_at = new Date().toISOString();
    else if (typeof prev.div_checked_at === "string") merged.div_checked_at = prev.div_checked_at;
    db.prepare(
      `INSERT INTO tickertape_ratios_cache (ticker, ratios_json, fetched_at)
       VALUES (@ticker, @ratios_json, @fetched_at)
       ON CONFLICT(ticker) DO UPDATE SET
         ratios_json = excluded.ratios_json,
         fetched_at = excluded.fetched_at`,
    ).run({
      ticker: key,
      ratios_json: JSON.stringify(merged),
      fetched_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
  mapCache = null;
}

/** True when a Tickertape row was written after an explicit div-yield fill attempt. */
export function tickertapeDivChecked(row: TickertapeStockRatios | null | undefined): boolean {
  if (!row) return false;
  const at = (row as { div_checked_at?: unknown }).div_checked_at;
  return typeof at === "string" && at.length > 0;
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
