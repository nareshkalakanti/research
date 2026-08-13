import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import investorsJson from "./investors.json";
import {
  fetchInvestorHoldings,
  invalidateResolverCaches,
  resolveHoldings,
  type InvestorSource,
  type ResolvedHolding,
} from "./scrape";
import { SUPERSTAR_INVESTORS } from "./catalog";
import { mergeDisclosedResolved } from "./disclosed";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "superstar_holdings.db");

const SOURCES = investorsJson as InvestorSource[];

export function listScanInvestors(): InvestorSource[] {
  const shortByName = new Map(SUPERSTAR_INVESTORS.map((i) => [i.name, i.short]));
  return SOURCES.map((s) => ({
    ...s,
    short: shortByName.get(s.name) ?? s.name,
  }));
}

function ensureDb(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS superstar_holdings (
      investor TEXT NOT NULL,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL DEFAULT 'NSE',
      company_name TEXT,
      holding_percent REAL,
      change_qtr REAL,
      change_type TEXT,
      holding_value_cr REAL,
      price REAL,
      fetched_at TEXT NOT NULL,
      sector TEXT,
      sub_sector TEXT,
      industry TEXT,
      screener_slug TEXT,
      holding_entity TEXT,
      PRIMARY KEY (investor, symbol, exchange)
    );
    CREATE TABLE IF NOT EXISTS superstar_symbol_cache (
      norm_name TEXT PRIMARY KEY,
      symbol TEXT,
      exchange TEXT,
      screener_slug TEXT,
      resolver_version INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_superstar_holdings_symbol
      ON superstar_holdings(symbol);
  `);
  return db;
}

function saveInvestorHoldings(
  db: Database.Database,
  investor: string,
  rows: ResolvedHolding[],
  fetchedAt: string,
): number {
  const del = db.prepare(`DELETE FROM superstar_holdings WHERE investor = ?`);
  const upsert = db.prepare(`
    INSERT INTO superstar_holdings (
      investor, symbol, exchange, company_name, holding_percent, change_qtr,
      change_type, holding_value_cr, price, fetched_at, sector, sub_sector,
      industry, screener_slug, holding_entity
    ) VALUES (
      @investor, @symbol, @exchange, @company_name, @holding_percent, @change_qtr,
      @change_type, @holding_value_cr, @price, @fetched_at, @sector, @sub_sector,
      @industry, @screener_slug, @holding_entity
    )
    ON CONFLICT(investor, symbol, exchange) DO UPDATE SET
      company_name = excluded.company_name,
      holding_percent = excluded.holding_percent,
      change_qtr = excluded.change_qtr,
      change_type = excluded.change_type,
      holding_value_cr = excluded.holding_value_cr,
      price = excluded.price,
      fetched_at = excluded.fetched_at,
      sector = excluded.sector,
      sub_sector = excluded.sub_sector,
      industry = excluded.industry,
      screener_slug = excluded.screener_slug,
      holding_entity = excluded.holding_entity
  `);

  const tx = db.transaction(() => {
    del.run(investor);
    let n = 0;
    for (const r of rows) {
      const symbol = (r.symbol || "").toUpperCase();
      if (!symbol) continue; // skip unresolved — keeps table clean
      upsert.run({
        investor,
        symbol,
        exchange: r.exchange || "NSE",
        company_name: r.company_name,
        holding_percent: r.holding_percent,
        change_qtr: r.change_qtr,
        change_type: r.change_type,
        holding_value_cr: r.holding_value_cr,
        price: r.price,
        fetched_at: fetchedAt,
        sector: r.sector,
        sub_sector: r.sub_sector,
        industry: r.industry,
        screener_slug: r.screener_slug,
        holding_entity: r.holding_entity ?? null,
      });
      n += 1;
    }
    return n;
  });
  return tx();
}

export type ScanBatchResult = {
  ok: boolean;
  offset: number;
  limit: number;
  total: number;
  done: number;
  remaining: number;
  pct: number;
  fetched_at: string;
  batch: Array<{
    name: string;
    short: string;
    holdings: number;
    sources: number;
    error?: string;
  }>;
  holdings_saved: number;
  error?: string;
};

/**
 * Scan a batch of curated investors in parallel (portfolio_id pages — fast).
 */
export async function scanInvestorBatch(opts?: {
  offset?: number;
  limit?: number;
  includeFunds?: boolean;
}): Promise<ScanBatchResult> {
  const all = listScanInvestors();
  const offset = Math.max(0, opts?.offset ?? 0);
  const limit = Math.min(8, Math.max(1, opts?.limit ?? 4));
  const slice = all.slice(offset, offset + limit);
  const fetchedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
  const db = ensureDb();

  try {
    const settled = await Promise.all(
      slice.map(async (inv) => {
        try {
          const { rows, sources, error } = await fetchInvestorHoldings(inv, {
            includeFunds: opts?.includeFunds ?? true,
            concurrency: 3,
          });
          const resolved = mergeDisclosedResolved(
            inv.name,
            resolveHoldings(rows),
          );
          const saved = saveInvestorHoldings(db, inv.name, resolved, fetchedAt);
          return {
            name: inv.name,
            short: inv.short || inv.name,
            holdings: saved,
            sources,
            error: saved === 0 ? error : undefined,
          };
        } catch (e) {
          return {
            name: inv.name,
            short: inv.short || inv.name,
            holdings: 0,
            sources: 0,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );

    const done = Math.min(offset + slice.length, all.length);
    const remaining = Math.max(0, all.length - done);
    const holdingsSaved = settled.reduce((a, b) => a + b.holdings, 0);

    return {
      ok: true,
      offset,
      limit,
      total: all.length,
      done,
      remaining,
      pct: all.length ? Math.round((done / all.length) * 100) : 100,
      fetched_at: fetchedAt,
      batch: settled,
      holdings_saved: holdingsSaved,
    };
  } catch (e) {
    return {
      ok: false,
      offset,
      limit,
      total: all.length,
      done: offset,
      remaining: Math.max(0, all.length - offset),
      pct: all.length ? Math.round((offset / all.length) * 100) : 0,
      fetched_at: fetchedAt,
      batch: [],
      holdings_saved: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    invalidateResolverCaches();
    db.close();
  }
}
