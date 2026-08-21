/**
 * Fund watchlists — Niveshaay & Negen (data/fund_watchlists.db).
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "fund_watchlists.db");
const SUPERSTAR_DB = path.join(DATA_DIR, "superstar_holdings.db");

export type FundWatchlistKey = "niveshaay" | "negen";

const FUND_INVESTOR_KEYS: Record<FundWatchlistKey, string> = {
  niveshaay: "Niveshaay",
  negen: "Negen Capital / Negen Undiscovered Value Fund",
};

export type FundWatchlistRow = {
  ticker: string;
  name: string | null;
  market: string;
  list_key: FundWatchlistKey;
};

let cache: {
  at: number;
  niveshaay: Set<string>;
  negen: Set<string>;
} | null = null;
const CACHE_MS = 30_000;

function open(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fund_watchlists (
      ticker TEXT NOT NULL,
      list_key TEXT NOT NULL,
      market TEXT,
      name TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (ticker, list_key)
    );
  `);
}

export function invalidateFundWatchlistCache(): void {
  cache = null;
}

function loadFromSuperstar(): { niveshaay: Set<string>; negen: Set<string> } {
  const niveshaay = new Set<string>();
  const negen = new Set<string>();
  if (!fs.existsSync(SUPERSTAR_DB)) return { niveshaay, negen };
  const db = new Database(SUPERSTAR_DB, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT UPPER(symbol) AS ticker, investor
         FROM superstar_holdings
         WHERE investor IN (?, ?)`,
      )
      .all(FUND_INVESTOR_KEYS.niveshaay, FUND_INVESTOR_KEYS.negen) as Array<{
      ticker: string;
      investor: string;
    }>;
    for (const r of rows) {
      if (r.investor === FUND_INVESTOR_KEYS.niveshaay) niveshaay.add(r.ticker);
      if (r.investor === FUND_INVESTOR_KEYS.negen) negen.add(r.ticker);
    }
  } finally {
    db.close();
  }
  return { niveshaay, negen };
}

function loadSets(): { niveshaay: Set<string>; negen: Set<string> } {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) {
    return { niveshaay: cache.niveshaay, negen: cache.negen };
  }

  const niveshaay = new Set<string>();
  const negen = new Set<string>();
  const db = open();
  if (db) {
    try {
      const rows = db
        .prepare(
          `SELECT UPPER(ticker) AS ticker, list_key FROM fund_watchlists`,
        )
        .all() as Array<{ ticker: string; list_key: string }>;
      for (const r of rows) {
        if (r.list_key === "niveshaay") niveshaay.add(r.ticker);
        if (r.list_key === "negen") negen.add(r.ticker);
      }
    } finally {
      db.close();
    }
  }

  if (!niveshaay.size && !negen.size) {
    const fallback = loadFromSuperstar();
    for (const t of fallback.niveshaay) niveshaay.add(t);
    for (const t of fallback.negen) negen.add(t);
  }

  cache = { at: now, niveshaay, negen };
  return { niveshaay, negen };
}

export function niveshaayTickerSet(): Set<string> {
  return loadSets().niveshaay;
}

export function negenTickerSet(): Set<string> {
  return loadSets().negen;
}

export function fundWatchlistCounts(): { niveshaay: number; negen: number } {
  const { niveshaay, negen } = loadSets();
  return { niveshaay: niveshaay.size, negen: negen.size };
}

export type FundWatchlistStub = {
  ticker: string;
  name: string;
  market: string;
};

export function loadFundWatchlistStubs(
  listKey: FundWatchlistKey,
  exclude: Set<string>,
): FundWatchlistStub[] {
  const db = open();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT UPPER(ticker) AS ticker,
                COALESCE(NULLIF(TRIM(name), ''), ticker) AS name,
                COALESCE(NULLIF(TRIM(market), ''), 'NSE') AS market
         FROM fund_watchlists
         WHERE list_key = ?
         ORDER BY ticker`,
      )
      .all(listKey) as FundWatchlistStub[];
    return rows.filter((r) => !exclude.has(r.ticker.toUpperCase()));
  } finally {
    db.close();
  }
}

export type FundWatchlistAboutRow = {
  ticker: string;
  name: string;
  market: string;
  list_key: FundWatchlistKey;
};

/** All fund watchlist rows (deduped by ticker; Negen wins name clash). */
export function loadAllFundWatchlistRows(): FundWatchlistAboutRow[] {
  const db = open();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT UPPER(ticker) AS ticker,
                COALESCE(NULLIF(TRIM(name), ''), ticker) AS name,
                COALESCE(NULLIF(TRIM(market), ''), 'NSE') AS market,
                list_key
         FROM fund_watchlists
         ORDER BY ticker, list_key`,
      )
      .all() as FundWatchlistAboutRow[];
    const byTicker = new Map<string, FundWatchlistAboutRow>();
    for (const r of rows) {
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, r);
    }
    return [...byTicker.values()];
  } finally {
    db.close();
  }
}

/** Upsert fund watchlist tickers missing from company_about.db. */
export function ensureFundWatchlistInCompanyAbout(
  rows?: FundWatchlistAboutRow[],
): number {
  const list = rows ?? loadAllFundWatchlistRows();
  if (!list.length) return 0;

  const aboutPath = path.join(DATA_DIR, "company_about.db");
  if (!fs.existsSync(aboutPath)) return 0;

  const about = new Database(aboutPath);
  try {
    const have = new Set(
      (
        about
          .prepare(`SELECT UPPER(ticker) AS t FROM company_about`)
          .all() as Array<{ t: string }>
      ).map((r) => r.t),
    );
    const ins = about.prepare(`
      INSERT INTO company_about (
        ticker, name, market, website, about, yf_about, scraped_about,
        company_sector, company_industry, headquarters,
        products, end_markets, theme_tags, source, fetched_at,
        has_website, has_yf_about, has_scraped_about
      ) VALUES (
        @ticker, @name, @market, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL,
        NULL, NULL, NULL, 'fund-watchlist-sync', @fetched_at,
        0, 0, 0
      )
    `);
    const now = new Date().toISOString();
    let n = 0;
    const tx = about.transaction(() => {
      for (const r of list) {
        const ticker = r.ticker.toUpperCase();
        if (!ticker || have.has(ticker)) continue;
        ins.run({
          ticker,
          name: r.name.trim() || ticker,
          market: (r.market || "NSE").toUpperCase(),
          fetched_at: now,
        });
        have.add(ticker);
        n += 1;
      }
    });
    tx();
    return n;
  } finally {
    about.close();
  }
}

export function isNiveshaay(ticker: string): boolean {
  return niveshaayTickerSet().has(ticker.toUpperCase());
}

export function isNegen(ticker: string): boolean {
  return negenTickerSet().has(ticker.toUpperCase());
}

export function replaceFundWatchlists(
  listKey: FundWatchlistKey,
  rows: Array<{
    ticker: string;
    name?: string | null;
    market?: string | null;
  }>,
): number {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  try {
    ensureSchema(db);
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM fund_watchlists WHERE list_key = ?`).run(listKey);
      const ins = db.prepare(
        `INSERT INTO fund_watchlists (ticker, list_key, market, name, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      let n = 0;
      for (const r of rows) {
        const ticker = (r.ticker || "").trim().toUpperCase();
        if (!ticker) continue;
        ins.run(
          ticker,
          listKey,
          (r.market || "NSE").toUpperCase(),
          r.name?.trim() || null,
          now,
        );
        n += 1;
      }
      return n;
    });
    const n = tx() as number;
    invalidateFundWatchlistCache();
    return n;
  } finally {
    db.close();
  }
}

/** Add or update watchlist rows without removing existing tickers (safe for manual adds). */
export function upsertFundWatchlistRows(
  listKey: FundWatchlistKey,
  rows: Array<{
    ticker: string;
    name?: string | null;
    market?: string | null;
  }>,
): number {
  if (!rows.length) return 0;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  try {
    ensureSchema(db);
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO fund_watchlists (ticker, list_key, market, name, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(ticker, list_key) DO UPDATE SET
        market = COALESCE(NULLIF(TRIM(excluded.market), ''), fund_watchlists.market),
        name = COALESCE(NULLIF(TRIM(excluded.name), ''), fund_watchlists.name),
        updated_at = excluded.updated_at
    `);
    let n = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const ticker = (r.ticker || "").trim().toUpperCase();
        if (!ticker) continue;
        stmt.run(
          ticker,
          listKey,
          (r.market || "NSE").toUpperCase(),
          r.name?.trim() || null,
          now,
        );
        n += 1;
      }
    });
    tx();
    invalidateFundWatchlistCache();
    return n;
  } finally {
    db.close();
  }
}
