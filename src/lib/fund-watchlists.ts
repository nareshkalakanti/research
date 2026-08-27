/**
 * Fund watchlists — ace investor books (data/fund_watchlists.db).
 * Pull from Trendlyne: npm run pull:fund-watchlists
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  isFundChangeVisible,
  type FundChangeInfo,
  type FundWatchlistKey,
} from "./fund-watchlist-meta";
import { invalidateCompanyCache } from "./db";

export {
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  type FundChangeInfo,
  type FundWatchlistKey,
} from "./fund-watchlist-meta";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "fund_watchlists.db");
const SUPERSTAR_DB = path.join(DATA_DIR, "superstar_holdings.db");

export type FundSource = {
  label: string;
  portfolio_id?: string | null;
  portfolio_slug?: string | null;
  query?: string | null;
};

/** Trendlyne scrape sources — inc/dec/new stored on pull. */
export const FUND_WATCHLIST_SOURCES: Record<
  FundWatchlistKey,
  FundSource & { extra_sources?: FundSource[] }
> = {
  niveshaay: {
    label: "Niveshaay",
    query: "NIVESHAAY",
  },
  negen: {
    label: "Negen Capital / Negen Undiscovered Value Fund",
    query: "NEGEN UNDISCOVERED VALUE FUND",
  },
  kacholia: {
    label: "Ashish Kacholia",
    portfolio_id: "53746",
    portfolio_slug: "ashish-kacholia-portfolio",
  },
  mukul: {
    label: "Mukul Agrawal",
    portfolio_id: "53774",
    portfolio_slug: "mukul-agrawal-portfolio",
  },
  kedia: {
    label: "Vijay Kishanlal Kedia",
    portfolio_id: "53805",
    portfolio_slug: "vijay-kishanlal-kedia-portfolio",
  },
  singhania: {
    label: "Sunil Singhania",
    portfolio_id: "182955",
    portfolio_slug: "sunil-singhania-portfolio",
    extra_sources: [
      {
        label: "Abakkus Fund",
        portfolio_id: "584233",
        portfolio_slug: "abakkus-fund-portfolio",
      },
    ],
  },
  kela: {
    label: "Madhusudan Kela",
    portfolio_id: "584325",
    portfolio_slug: "madhusudan-kela-portfolio",
  },
};

const FUND_INVESTOR_KEYS: Record<FundWatchlistKey, string> = {
  niveshaay: "Niveshaay",
  negen: "Negen Capital / Negen Undiscovered Value Fund",
  kacholia: "Ashish Kacholia",
  mukul: "Mukul Agrawal",
  kedia: "Vijay Kishanlal Kedia",
  singhania: "Sunil Singhania",
  kela: "Madhusudan Kela",
};

export type FundWatchlistRow = {
  ticker: string;
  name: string | null;
  market: string;
  list_key: FundWatchlistKey;
};

type FundSets = Record<FundWatchlistKey, Set<string>>;
type FundChangesByTicker = Map<
  string,
  Partial<Record<FundWatchlistKey, FundChangeInfo>>
>;

let cache: { at: number; sets: FundSets; changes: FundChangesByTicker } | null =
  null;
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
      change_qtr REAL,
      change_type TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (ticker, list_key)
    );
  `);
  ensureChangeColumns(db);
}

function ensureChangeColumns(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(fund_watchlists)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("change_qtr")) {
    db.exec(`ALTER TABLE fund_watchlists ADD COLUMN change_qtr REAL`);
  }
  if (!names.has("change_type")) {
    db.exec(`ALTER TABLE fund_watchlists ADD COLUMN change_type TEXT`);
  }
}

export function invalidateFundWatchlistCache(): void {
  cache = null;
}

function emptySets(): FundSets {
  return Object.fromEntries(
    FUND_WATCHLIST_KEYS.map((k) => [k, new Set<string>()]),
  ) as FundSets;
}

function loadFromSuperstar(): FundSets {
  const sets = emptySets();
  if (!fs.existsSync(SUPERSTAR_DB)) return sets;
  const db = new Database(SUPERSTAR_DB, { readonly: true, fileMustExist: true });
  try {
    const investors = FUND_WATCHLIST_KEYS.map((k) => FUND_INVESTOR_KEYS[k]);
    const placeholders = investors.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT UPPER(symbol) AS ticker, investor
         FROM superstar_holdings
         WHERE investor IN (${placeholders})`,
      )
      .all(...investors) as Array<{ ticker: string; investor: string }>;
    for (const r of rows) {
      for (const key of FUND_WATCHLIST_KEYS) {
        if (r.investor === FUND_INVESTOR_KEYS[key]) sets[key].add(r.ticker);
      }
    }
  } finally {
    db.close();
  }
  return sets;
}

function loadSetsAndChanges(): { sets: FundSets; changes: FundChangesByTicker } {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) {
    return { sets: cache.sets, changes: cache.changes };
  }

  const sets = emptySets();
  const changes: FundChangesByTicker = new Map();
  const db = open();
  if (db) {
    try {
      const rows = db
        .prepare(
          `SELECT UPPER(ticker) AS ticker, list_key, change_type, change_qtr
           FROM fund_watchlists`,
        )
        .all() as Array<{
        ticker: string;
        list_key: string;
        change_type: string | null;
        change_qtr: number | null;
      }>;
      for (const r of rows) {
        const key = r.list_key as FundWatchlistKey;
        if (!(key in sets)) continue;
        sets[key].add(r.ticker);
        if (isFundChangeVisible(r.change_type)) {
          const row = changes.get(r.ticker) ?? {};
          row[key] = {
            change_type: (r.change_type ?? "unchanged").toLowerCase(),
            change_qtr:
              r.change_qtr != null && Number.isFinite(r.change_qtr)
                ? r.change_qtr
                : null,
          };
          changes.set(r.ticker, row);
        }
      }
    } finally {
      db.close();
    }
  }

  if (FUND_WATCHLIST_KEYS.every((k) => !sets[k].size)) {
    const fallback = loadFromSuperstar();
    for (const key of FUND_WATCHLIST_KEYS) {
      for (const t of fallback[key]) sets[key].add(t);
    }
  }

  cache = { at: now, sets, changes };
  return { sets, changes };
}

function loadSets(): FundSets {
  return loadSetsAndChanges().sets;
}

export function fundWatchlistSets(): FundSets {
  return loadSets();
}

export function fundTickerSet(key: FundWatchlistKey): Set<string> {
  return loadSets()[key];
}

export function niveshaayTickerSet(): Set<string> {
  return fundTickerSet("niveshaay");
}

export function negenTickerSet(): Set<string> {
  return fundTickerSet("negen");
}

export function kacholiaTickerSet(): Set<string> {
  return fundTickerSet("kacholia");
}

export function fundWatchlistCounts(): Record<FundWatchlistKey, number> {
  const sets = loadSets();
  return Object.fromEntries(
    FUND_WATCHLIST_KEYS.map((k) => [k, sets[k].size]),
  ) as Record<FundWatchlistKey, number>;
}

export function isFundMember(
  ticker: string,
  key: FundWatchlistKey,
): boolean {
  return fundTickerSet(key).has(ticker.toUpperCase());
}

export function fundTagsForTicker(ticker: string): FundWatchlistKey[] {
  const t = ticker.toUpperCase();
  const sets = loadSets();
  return FUND_WATCHLIST_KEYS.filter((k) => sets[k].has(t));
}

export function fundChangesForTicker(
  ticker: string,
): Partial<Record<FundWatchlistKey, FundChangeInfo>> {
  const t = ticker.toUpperCase();
  return loadSetsAndChanges().changes.get(t) ?? {};
}

/** Intersection of all active fund-list filters. */
export function activeFundFilterSet(
  active: Partial<Record<FundWatchlistKey, boolean>>,
): Set<string> | null {
  const sets = loadSets();
  const keys = FUND_WATCHLIST_KEYS.filter((k) => active[k]);
  if (!keys.length) return null;
  let result = sets[keys[0]];
  for (let i = 1; i < keys.length; i++) {
    result = new Set([...result].filter((t) => sets[keys[i]].has(t)));
  }
  return result;
}

export function fundWatchlistAllTickers(): Set<string> {
  const sets = loadSets();
  const all = new Set<string>();
  for (const key of FUND_WATCHLIST_KEYS) {
    for (const t of sets[key]) all.add(t);
  }
  return all;
}

export function parseFundFiltersFromSearchParams(
  sp: URLSearchParams | { get: (k: string) => string | null },
): Partial<Record<FundWatchlistKey, boolean>> {
  return Object.fromEntries(
    FUND_WATCHLIST_KEYS.map((k) => [k, sp.get(k) === "1"]),
  ) as Partial<Record<FundWatchlistKey, boolean>>;
}

export function anyFundFilterActive(
  active: Partial<Record<FundWatchlistKey, boolean>>,
): boolean {
  return FUND_WATCHLIST_KEYS.some((k) => active[k]);
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

/** All fund watchlist rows (deduped by ticker; first list_key wins). */
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
    const updName = about.prepare(`
      UPDATE company_about
      SET name = @name
      WHERE UPPER(ticker) = @ticker
        AND UPPER(TRIM(name)) = UPPER(ticker)
        AND @name != @ticker
    `);
    const now = new Date().toISOString();
    let n = 0;
    let namesPatched = 0;
    const tx = about.transaction(() => {
      for (const r of list) {
        const ticker = r.ticker.toUpperCase();
        const name = r.name.trim() || ticker;
        if (!ticker) continue;
        if (!have.has(ticker)) {
          ins.run({
            ticker,
            name,
            market: (r.market || "NSE").toUpperCase(),
            fetched_at: now,
          });
          have.add(ticker);
          n += 1;
          continue;
        }
        if (name.toUpperCase() !== ticker) {
          namesPatched += updName.run({ ticker, name }).changes;
        }
      }
    });
    tx();
    if (n > 0 || namesPatched > 0) invalidateCompanyCache();
    return n;
  } finally {
    about.close();
  }
}

export function isNiveshaay(ticker: string): boolean {
  return isFundMember(ticker, "niveshaay");
}

export function isNegen(ticker: string): boolean {
  return isFundMember(ticker, "negen");
}

export function isKacholia(ticker: string): boolean {
  return isFundMember(ticker, "kacholia");
}

export function replaceFundWatchlists(
  listKey: FundWatchlistKey,
  rows: Array<{
    ticker: string;
    name?: string | null;
    market?: string | null;
    change_qtr?: number | null;
    change_type?: string | null;
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
        `INSERT INTO fund_watchlists (ticker, list_key, market, name, change_qtr, change_type, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      let n = 0;
      for (const r of rows) {
        const ticker = (r.ticker || "").trim().toUpperCase();
        if (!ticker) continue;
        const changeType = (r.change_type ?? "unchanged").toLowerCase();
        ins.run(
          ticker,
          listKey,
          (r.market || "NSE").toUpperCase(),
          r.name?.trim() || null,
          r.change_qtr != null && Number.isFinite(r.change_qtr)
            ? r.change_qtr
            : null,
          changeType,
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

export function upsertFundWatchlistRows(
  listKey: FundWatchlistKey,
  rows: Array<{
    ticker: string;
    name?: string | null;
    market?: string | null;
    change_qtr?: number | null;
    change_type?: string | null;
  }>,
): number {
  if (!rows.length) return 0;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  try {
    ensureSchema(db);
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO fund_watchlists (ticker, list_key, market, name, change_qtr, change_type, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker, list_key) DO UPDATE SET
        market = COALESCE(NULLIF(TRIM(excluded.market), ''), fund_watchlists.market),
        name = COALESCE(NULLIF(TRIM(excluded.name), ''), fund_watchlists.name),
        change_qtr = excluded.change_qtr,
        change_type = excluded.change_type,
        updated_at = excluded.updated_at
    `);
    let n = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const ticker = (r.ticker || "").trim().toUpperCase();
        if (!ticker) continue;
        const changeType = (r.change_type ?? "unchanged").toLowerCase();
        stmt.run(
          ticker,
          listKey,
          (r.market || "NSE").toUpperCase(),
          r.name?.trim() || null,
          r.change_qtr != null && Number.isFinite(r.change_qtr)
            ? r.change_qtr
            : null,
          changeType,
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
