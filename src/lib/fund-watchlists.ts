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
  formatFundDisplayLabel,
  isFundChangeVisible,
  type FundChangeInfo,
  type FundWatchlistKey,
} from "./fund-watchlist-meta";
import { invalidateCompanyCache } from "./db";

export {
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  formatFundDisplayLabel,
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
  /** Screener people page (reference; pull uses Trendlyne until Screener scrape exists). */
  screener_people_url?: string | null;
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
  manohar: {
    label: "Manohar Devabhaktuni",
    query: "MANOHAR DEVABHAKTUNI",
  },
  lucky: {
    label: "Lucky Investment Managers",
    query: "LUCKY INVESTMENT MANAGERS",
  },
  abbakus: {
    label: "Abbakus Asset Managers",
    query: "ABBAKUS ASSET MANAGERS",
  },
  porinju: {
    label: "Porinju V Veliyath",
    portfolio_id: "53777",
    portfolio_slug: "porinju-v-veliyath",
    query: "PORINJU V VELIYATH",
  },
  equityint: {
    label: "Equity Intelligence India Private Limited",
    query: "EQUITY INTELLIGENCE INDIA PRIVATE LIMITED",
    screener_people_url:
      "https://www.screener.in/people/78278/equity-intelligence-india-private-ltd/",
  },
  sageone: {
    label: "SageOne Investment Managers",
    query: "SAGEONE",
  },
  greenlantern: {
    label: "Green Lantern Capital",
    query: "GREEN LANTERN CAPITAL",
  },
  carnelian: {
    label: "Carnelian Asset Management",
    query: "CARNELIAN ASSET MANAGEMENT",
  },
  whitepine: {
    label: "White Pine Investment",
    query: "WHITE PINE INVESTMENT",
  },
  kriis: {
    label: "KRIIS Portfolio",
    query: "KRIIS",
  },
  alfaccurate: {
    label: "AlfAccurate Advisors",
    query: "ALFACCURATE ADVISORS",
  },
  moneygrow: {
    label: "MoneyGrow Asset",
    query: "MONEYGROW ASSET",
  },
  equirus: {
    label: "Equirus Wealth",
    query: "EQUIRUS WEALTH",
  },
  stallion: {
    label: "Stallion Asset",
    query: "STALLION ASSET",
  },
  buoyant: {
    label: "Buoyant Capital",
    query: "BUOYANT CAPITAL",
    extra_sources: [
      {
        label: "Buoyant Capital AIF",
        query: "BUOYANT CAPITAL AIF",
      },
      {
        label: "Buoyant Opportunities",
        query: "BUOYANT OPPORTUNITIES",
      },
    ],
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
  manohar: "Manohar Devabhaktuni",
  lucky: "Lucky Investment Managers",
  abbakus: "Abbakus Asset Managers",
  porinju: "Porinju V Veliyath",
  equityint: "Equity Intelligence India Private Limited",
  sageone: "SageOne Investment Managers",
  greenlantern: "Green Lantern Capital",
  carnelian: "Carnelian Asset Management",
  whitepine: "White Pine Investment",
  kriis: "KRIIS Portfolio",
  alfaccurate: "AlfAccurate Advisors",
  moneygrow: "MoneyGrow Asset",
  equirus: "Equirus Wealth",
  stallion: "Stallion Asset",
  buoyant: "Buoyant Capital",
};

/** When Trendlyne custom search is fuzzy, keep only matching holder names. */
export const FUND_WATCHLIST_HOLDER_FILTER: Partial<
  Record<FundWatchlistKey, RegExp>
> = {
  manohar: /manohar\s+devabhaktuni/i,
  equityint: /equity\s+intelligence/i,
  greenlantern: /green\s+lantern/i,
  carnelian: /carnelian/i,
  whitepine: /white\s+pine/i,
  kriis: /kriis/i,
  alfaccurate: /alfaccurate/i,
  moneygrow: /moneygrow|money\s*grow/i,
  equirus: /equirus/i,
  stallion: /stallion/i,
  buoyant: /buoyant/i,
};

export type FundWatchlistRow = {
  ticker: string;
  name: string | null;
  market: string;
  list_key: string;
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
    CREATE TABLE IF NOT EXISTS fund_list_meta (
      list_key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
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
  const all = new Set<string>();
  const sets = loadSets();
  for (const key of FUND_WATCHLIST_KEYS) {
    for (const t of sets[key]) all.add(t);
  }
  // Include custom fund lists (not in FUND_WATCHLIST_KEYS).
  const db = open();
  if (db) {
    try {
      const rows = db
        .prepare(`SELECT DISTINCT UPPER(ticker) AS ticker FROM fund_watchlists`)
        .all() as Array<{ ticker: string }>;
      for (const r of rows) all.add(r.ticker);
    } finally {
      db.close();
    }
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
  listKey: string,
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
  list_key: string;
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
  listKey: FundWatchlistKey | string,
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
  listKey: FundWatchlistKey | string,
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

export type FundCatalogEntry = {
  key: string;
  label: string;
  count: number;
  builtin: boolean;
};

function slugifyFundLabel(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40);
  return base || `fund${Date.now().toString(36)}`;
}

function openWritable(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  ensureSchema(db);
  return db;
}

/** Builtin + custom fund lists with live member counts. */
export function listFundCatalog(): FundCatalogEntry[] {
  const counts = new Map<string, number>();
  const customLabels = new Map<string, string>();
  if (fs.existsSync(DB_PATH)) {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try {
      db.pragma("query_only = ON");
      for (const r of db
        .prepare(
          `SELECT list_key, COUNT(*) AS n FROM fund_watchlists GROUP BY list_key`,
        )
        .all() as Array<{ list_key: string; n: number }>) {
        counts.set(r.list_key, r.n);
      }
      try {
        for (const r of db
          .prepare(`SELECT list_key, label FROM fund_list_meta`)
          .all() as Array<{ list_key: string; label: string }>) {
          customLabels.set(r.list_key, r.label);
        }
      } catch {
        /* table may not exist yet */
      }
    } finally {
      db.close();
    }
  }

  const seen = new Set<string>();
  const out: FundCatalogEntry[] = [];
  for (const key of FUND_WATCHLIST_KEYS) {
    seen.add(key);
    out.push({
      key,
      label: FUND_WATCHLIST_LABELS[key],
      count: counts.get(key) ?? 0,
      builtin: true,
    });
  }
  for (const [key, label] of customLabels) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: formatFundDisplayLabel(label),
      count: counts.get(key) ?? 0,
      builtin: false,
    });
  }
  for (const [key, n] of counts) {
    if (seen.has(key)) continue;
    out.push({
      key,
      label: formatFundDisplayLabel(key),
      count: n,
      builtin: false,
    });
  }
  out.sort((a, b) =>
    a.label.localeCompare(b.label, "en", { sensitivity: "base" }),
  );
  return out;
}

export function createFundList(label: string): FundCatalogEntry {
  const trimmed = label.trim().replace(/\s+/g, " ").slice(0, 80);
  if (trimmed.length < 2) throw new Error("Fund name too short");
  let key = slugifyFundLabel(trimmed);
  const db = openWritable();
  try {
    const existing = new Set(
      (
        db.prepare(`SELECT list_key FROM fund_list_meta`).all() as Array<{
          list_key: string;
        }>
      ).map((r) => r.list_key),
    );
    for (const k of FUND_WATCHLIST_KEYS) existing.add(k);
    if (existing.has(key)) {
      let i = 2;
      while (existing.has(`${key}${i}`)) i += 1;
      key = `${key}${i}`;
    }
    db.prepare(
      `INSERT INTO fund_list_meta (list_key, label, created_at) VALUES (?, ?, ?)`,
    ).run(key, trimmed, new Date().toISOString());
    invalidateFundWatchlistCache();
    return { key, label: trimmed, count: 0, builtin: false };
  } finally {
    db.close();
  }
}

/** Delete a custom fund list (meta + all holdings). Builtin catalog keys are blocked. */
export function deleteFundList(listKey: string): {
  key: string;
  label: string;
  cleared: number;
} {
  const key = listKey.trim();
  if (!key) throw new Error("list required");
  if ((FUND_WATCHLIST_KEYS as string[]).includes(key)) {
    throw new Error("Builtin fund lists cannot be deleted");
  }
  const db = openWritable();
  try {
    const meta = db
      .prepare(`SELECT label FROM fund_list_meta WHERE list_key = ?`)
      .get(key) as { label: string } | undefined;
    const holdingCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fund_watchlists WHERE list_key = ?`,
        )
        .get(key) as { n: number } | undefined
    )?.n;
    if (!meta && !(holdingCount && holdingCount > 0)) {
      throw new Error("Fund not found");
    }
    const cleared = db
      .prepare(`DELETE FROM fund_watchlists WHERE list_key = ?`)
      .run(key).changes;
    db.prepare(`DELETE FROM fund_list_meta WHERE list_key = ?`).run(key);
    invalidateFundWatchlistCache();
    return {
      key,
      label: formatFundDisplayLabel(meta?.label?.trim() || key),
      cleared,
    };
  } finally {
    db.close();
  }
}

export type FundHoldingRow = {
  ticker: string;
  name: string;
  market: string;
  change_type: string | null;
  change_qtr: number | null;
  updated_at: string | null;
};

export function loadFundHoldings(listKey: string): FundHoldingRow[] {
  const db = open();
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT UPPER(ticker) AS ticker,
                COALESCE(NULLIF(TRIM(name), ''), ticker) AS name,
                COALESCE(NULLIF(TRIM(market), ''), 'NSE') AS market,
                change_type,
                change_qtr,
                updated_at
         FROM fund_watchlists
         WHERE list_key = ?
         ORDER BY
           CASE LOWER(COALESCE(change_type, ''))
             WHEN 'new' THEN 0
             WHEN 'disclosed' THEN 1
             WHEN 'increased' THEN 2
             WHEN 'decreased' THEN 3
             ELSE 4
           END,
           ticker`,
      )
      .all(listKey) as FundHoldingRow[];
  } finally {
    db.close();
  }
}

export function deleteFundWatchlistTicker(
  listKey: string,
  ticker: string,
): boolean {
  const t = ticker.trim().toUpperCase();
  if (!t) return false;
  const db = openWritable();
  try {
    const info = db
      .prepare(`DELETE FROM fund_watchlists WHERE list_key = ? AND ticker = ?`)
      .run(listKey, t);
    invalidateFundWatchlistCache();
    return info.changes > 0;
  } finally {
    db.close();
  }
}

export function fundLabelForKey(listKey: string): string {
  if ((FUND_WATCHLIST_KEYS as string[]).includes(listKey)) {
    return FUND_WATCHLIST_LABELS[listKey as FundWatchlistKey];
  }
  if (!fs.existsSync(DB_PATH)) return formatFundDisplayLabel(listKey);
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(`SELECT label FROM fund_list_meta WHERE list_key = ?`)
      .get(listKey) as { label: string } | undefined;
    return formatFundDisplayLabel(row?.label?.trim() || listKey);
  } catch {
    return formatFundDisplayLabel(listKey);
  } finally {
    db.close();
  }
}

export type FundTickerFreq = {
  ticker: string;
  name: string;
  market: string;
  count: number;
  lists: string[];
};

/** How many fund lists each ticker appears in (across all watchlists). */
export function fundTickerFrequency(): FundTickerFreq[] {
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
      .all() as Array<{
      ticker: string;
      name: string;
      market: string;
      list_key: string;
    }>;
    const map = new Map<string, FundTickerFreq>();
    for (const r of rows) {
      const cur = map.get(r.ticker);
      if (!cur) {
        map.set(r.ticker, {
          ticker: r.ticker,
          name: r.name,
          market: r.market,
          count: 1,
          lists: [r.list_key],
        });
      } else {
        if (!cur.lists.includes(r.list_key)) {
          cur.lists.push(r.list_key);
          cur.count = cur.lists.length;
        }
        if ((!cur.name || cur.name === cur.ticker) && r.name) cur.name = r.name;
      }
    }
    return [...map.values()];
  } finally {
    db.close();
  }
}

function companyMarketByTicker(): Map<string, string> {
  try {
    // Lazy require avoids circular init with db ↔ fund helpers.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadAllCompanies } = require("./db") as {
      loadAllCompanies: () => Array<{ ticker: string; market: string }>;
    };
    const map = new Map<string, string>();
    for (const c of loadAllCompanies()) {
      map.set(c.ticker.toUpperCase(), c.market);
    }
    return map;
  } catch {
    return new Map();
  }
}

export function fundOverlapStats(): {
  all: number;
  unique: number;
  overlap: number;
  sme: number;
  frequency: FundTickerFreq[];
} {
  const frequency = fundTickerFrequency();
  const markets = companyMarketByTicker();
  let unique = 0;
  let overlap = 0;
  let sme = 0;
  for (const f of frequency) {
    if (f.count === 1) unique += 1;
    if (f.count >= 2) overlap += 1;
    const market = markets.get(f.ticker.toUpperCase()) || f.market;
    if (/\bSME\b/i.test(market)) sme += 1;
  }
  return { all: frequency.length, unique, overlap, sme, frequency };
}
