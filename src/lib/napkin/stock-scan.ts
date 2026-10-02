/**
 * Napkin stock scanner rows from cached Screener annual EPS.
 * Does not call Yahoo, Groww, or an LLM. Listing year is not a filter.
 */
import { openSqliteNamed } from "@/lib/sqlite-utils";
import {
  napkinStockScanRow,
  parseMinEpsHistory,
  passesMinEpsHistory,
  type MinEpsHistory,
  type NapkinStockScanRow,
} from "./eps-history";

export type { NapkinStockScanRow };

function namesByTicker(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const db = openSqliteNamed("company_about.db", {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = db
        .prepare(`SELECT ticker, name FROM company_about`)
        .all() as Array<{ ticker: string; name: string | null }>;
      for (const row of rows) {
        const t = (row.ticker || "").trim().toUpperCase();
        const name = (row.name || "").trim();
        if (t && name) map.set(t, name);
      }
    } finally {
      db.close();
    }
  } catch {
    /* about db optional */
  }
  return map;
}

function readPeRows(
  db: ReturnType<typeof openSqliteNamed>,
  table: "pead_web_metrics" | "napkin_scan_quotes",
): Map<string, number> {
  const map = new Map<string, number>();
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  if (!exists) return map;
  const rows = db
    .prepare(`SELECT ticker, pe_ratio FROM ${table}`)
    .all() as Array<{ ticker: string; pe_ratio: number | null }>;
  for (const row of rows) {
    const pe = row.pe_ratio;
    if (typeof pe !== "number" || !Number.isFinite(pe)) continue;
    map.set((row.ticker || "").trim().toUpperCase(), pe);
  }
  return map;
}

function peByTicker(db: ReturnType<typeof openSqliteNamed>): Map<string, number> {
  const map = readPeRows(db, "pead_web_metrics");
  for (const [ticker, pe] of readPeRows(db, "napkin_scan_quotes")) {
    map.set(ticker, pe);
  }
  return map;
}

/** Cached P/E for every ticker, including those without a Screener annual series. */
export function loadPeByTicker(): Map<string, number> {
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      return peByTicker(db);
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}

function marketByTicker(db: ReturnType<typeof openSqliteNamed>): Map<string, string> {
  const map = new Map<string, string>();
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stock_metrics'`,
    )
    .get();
  if (!exists) return map;
  const rows = db
    .prepare(`SELECT ticker, market FROM stock_metrics`)
    .all() as Array<{ ticker: string; market: string | null }>;
  for (const row of rows) {
    const market = (row.market || "").trim();
    if (!market) continue;
    map.set((row.ticker || "").trim().toUpperCase(), market);
  }
  return map;
}

function priceByTicker(db: ReturnType<typeof openSqliteNamed>): Map<string, number> {
  const map = new Map<string, number>();
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stock_metrics'`,
    )
    .get();
  if (!exists) return map;
  const rows = db
    .prepare(`SELECT ticker, price FROM stock_metrics`)
    .all() as Array<{ ticker: string; price: number | null }>;
  for (const row of rows) {
    const price = row.price;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    map.set((row.ticker || "").trim().toUpperCase(), price);
  }
  return map;
}

function epsTtmByTicker(db: ReturnType<typeof openSqliteNamed>): Map<string, number> {
  const map = new Map<string, number>();
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pead_web_metrics'`,
    )
    .get();
  if (!exists) return map;
  const rows = db
    .prepare(`SELECT ticker, eps_ttm FROM pead_web_metrics`)
    .all() as Array<{ ticker: string; eps_ttm: number | null }>;
  for (const row of rows) {
    const eps = row.eps_ttm;
    if (typeof eps !== "number" || !Number.isFinite(eps)) continue;
    map.set((row.ticker || "").trim().toUpperCase(), eps);
  }
  return map;
}

function mcapByTicker(db: ReturnType<typeof openSqliteNamed>): Map<string, number> {
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

function numList(raw: unknown): Array<number | null> {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
}

function cachedAnnuals(
  db: ReturnType<typeof openSqliteNamed>,
): Array<{
  ticker: string;
  eps: Array<number | null>;
  sales: Array<number | null>;
  roce: Array<number | null>;
}> {
  const out: Array<{
    ticker: string;
    eps: Array<number | null>;
    sales: Array<number | null>;
    roce: Array<number | null>;
  }> = [];
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'screener_annual_cache'`,
    )
    .get();
  if (!exists) return out;
  const rows = db
    .prepare(`SELECT ticker, annual_json FROM screener_annual_cache`)
    .all() as Array<{ ticker: string; annual_json: string }>;
  for (const row of rows) {
    let eps: Array<number | null> = [];
    let sales: Array<number | null> = [];
    let roce: Array<number | null> = [];
    try {
      const parsed = JSON.parse(row.annual_json) as {
        eps?: unknown;
        sales?: unknown;
        roce?: unknown;
      };
      eps = numList(parsed.eps);
      sales = numList(parsed.sales);
      roce = numList(parsed.roce);
    } catch {
      eps = [];
    }
    const ticker = (row.ticker || "").trim().toUpperCase();
    if (!ticker) continue;
    out.push({ ticker, eps, sales, roce });
  }
  return out;
}

export function loadNapkinStockScan(minRaw?: string | null): {
  min_history: MinEpsHistory;
  rows: NapkinStockScanRow[];
  quote_missing: number;
  quote_total: number;
} {
  const min_history = parseMinEpsHistory(minRaw);
  const names = namesByTicker();
  let rows: NapkinStockScanRow[] = [];
  let quote_missing = 0;
  let quote_total = 0;
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const pes = peByTicker(db);
      const mcaps = mcapByTicker(db);
      const prices = priceByTicker(db);
      const markets = marketByTicker(db);
      const epsTtm = epsTtmByTicker(db);
      const annuals = cachedAnnuals(db);
      quote_total = annuals.length;
      quote_missing = annuals.filter((row) => !prices.has(row.ticker)).length;
      rows = annuals.map((row) =>
        napkinStockScanRow({
          ticker: row.ticker,
          name: names.get(row.ticker),
          eps: row.eps,
          sales: row.sales,
          roce: row.roce,
          market_cap_cr: mcaps.get(row.ticker) ?? null,
          pe: pes.get(row.ticker) ?? null,
          price: prices.get(row.ticker) ?? null,
          current_eps: epsTtm.get(row.ticker) ?? null,
          market: markets.get(row.ticker) ?? null,
        }),
      );
    } finally {
      db.close();
    }
  } catch {
    rows = [];
  }
  return {
    min_history,
    quote_missing,
    quote_total,
    rows: rows
      .filter((row) => passesMinEpsHistory(row.history, min_history))
      .sort((a, b) => a.name.localeCompare(b.name) || a.ticker.localeCompare(b.ticker)),
  };
}
