import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { hasUsableAboutText, hasUsableYfAbout } from "./db";
import { websiteUrl, screenerUrl } from "./links";

const DATA_DIR = path.join(process.cwd(), "data");
const SCRAPER_PATH = path.join(DATA_DIR, "scraper.db");
const ABOUT_PATH = path.join(DATA_DIR, "company_about.db");

export type ScrapeStatus =
  | "pending"
  | "ok"
  | "empty"
  | "failed"
  | "blocked"
  | "covered"
  | "manual";

export type ScrapeRow = {
  ticker: string;
  name: string;
  market: string;
  website: string | null;
  web: string | null;
  sc: string;
  website_status: string | null;
  yf_about: string | null;
  about: string | null;
  scraped_about: string | null;
  source_url: string | null;
  scrape_source: "website" | null;
  status: ScrapeStatus;
  error: string | null;
  char_count: number;
  scraped_at: string | null;
};

export type ScrapeListResult = {
  rows: ScrapeRow[];
  total: number;
  page: number;
  pages: number;
  stats: {
    pending: number;
    ok: number;
    failed: number;
    covered: number;
    todo: number;
    with_web: number;
  };
  markets: Record<string, number>;
};

export type ScrapeFilter = "todo" | "failed";

let writeDb: Database.Database | null = null;

function ensureScraperDb(): Database.Database {
  if (writeDb) return writeDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(SCRAPER_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_scrape (
      ticker TEXT PRIMARY KEY,
      scraped_about TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      char_count INTEGER NOT NULL DEFAULT 0,
      scraped_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_company_scrape_status ON company_scrape(status);
  `);
  const cols = db.prepare(`PRAGMA table_info(company_scrape)`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "source_url")) {
    db.exec(`ALTER TABLE company_scrape ADD COLUMN source_url TEXT`);
  }
  if (!cols.some((c) => c.name === "scrape_source")) {
    db.exec(`ALTER TABLE company_scrape ADD COLUMN scrape_source TEXT`);
  }
  writeDb = db;
  return db;
}

function aboutDb(): Database.Database | null {
  if (!fs.existsSync(ABOUT_PATH)) return null;
  return new Database(ABOUT_PATH, { readonly: true, fileMustExist: true });
}

/** ticker → manual about text. */
export function loadManualAboutMap(): Map<string, string | null> {
  const about = aboutDb();
  const map = new Map<string, string | null>();
  if (!about) return map;
  try {
    for (const r of about
      .prepare(`SELECT ticker, about FROM company_about`)
      .all() as Array<{ ticker: string; about: string | null }>) {
      map.set(r.ticker.toUpperCase(), r.about);
    }
  } finally {
    about.close();
  }
  return map;
}

/** ticker → yf_about (read-only snapshot). */
export function loadYfAboutMap(): Map<string, string | null> {
  const about = aboutDb();
  const map = new Map<string, string | null>();
  if (!about) return map;
  try {
    for (const r of about
      .prepare(`SELECT ticker, yf_about FROM company_about`)
      .all() as Array<{ ticker: string; yf_about: string | null }>) {
      map.set(r.ticker.toUpperCase(), r.yf_about);
    }
  } finally {
    about.close();
  }
  return map;
}

/** Seed scrape rows from company_about (existing scraped text + website universe). */
export function syncScraperFromCompanyAbout(): number {
  const about = aboutDb();
  if (!about) return 0;
  const db = ensureScraperDb();
  try {
    const rows = about
      .prepare(
        `SELECT ticker, TRIM(COALESCE(scraped_about, '')) AS scraped,
                website_status
         FROM company_about
         WHERE TRIM(COALESCE(website, '')) != ''`,
      )
      .all() as Array<{
      ticker: string;
      scraped: string;
      website_status: string | null;
    }>;

    const ins = db.prepare(`
      INSERT INTO company_scrape (ticker, scraped_about, status, error, char_count, scraped_at, updated_at)
      VALUES (@ticker, @scraped_about, @status, NULL, @char_count, @scraped_at, @updated_at)
      ON CONFLICT(ticker) DO NOTHING
    `);
    const now = new Date().toISOString();
    let n = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const scraped = r.scraped || null;
        if (!scraped) continue;
        const res = ins.run({
          ticker: r.ticker.toUpperCase(),
          scraped_about: scraped,
          status:
            r.website_status === "ok" || scraped.length >= 80 ? "ok" : "empty",
          char_count: scraped.length,
          scraped_at: now,
          updated_at: now,
        });
        n += res.changes;
      }
    });
    tx();
    return n;
  } finally {
    about.close();
  }
}

export function upsertScrapeResult(
  ticker: string,
  opts: {
    scraped_about: string | null;
    status: ScrapeStatus;
    error?: string | null;
    source_url?: string | null;
    scrape_source?: "website" | null;
  },
): void {
  const db = ensureScraperDb();
  const key = ticker.toUpperCase();
  const text = opts.scraped_about?.trim() || null;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO company_scrape (ticker, scraped_about, status, error, char_count, scraped_at, updated_at, source_url, scrape_source)
     VALUES (@ticker, @scraped_about, @status, @error, @char_count, @scraped_at, @updated_at, @source_url, @scrape_source)
     ON CONFLICT(ticker) DO UPDATE SET
       scraped_about = excluded.scraped_about,
       status = excluded.status,
       error = excluded.error,
       char_count = excluded.char_count,
       scraped_at = excluded.scraped_at,
       updated_at = excluded.updated_at,
       source_url = excluded.source_url,
       scrape_source = excluded.scrape_source`,
  ).run({
    ticker: key,
    scraped_about: text,
    status: opts.status,
    error: opts.error ?? null,
    char_count: text?.length ?? 0,
    scraped_at: opts.status === "ok" ? now : null,
    updated_at: now,
    source_url: opts.source_url ?? null,
    scrape_source: opts.scrape_source ?? null,
  });
}

export function resetScrapeForTicker(ticker: string): void {
  const db = ensureScraperDb();
  db.prepare(`DELETE FROM company_scrape WHERE ticker = ?`).run(
    ticker.toUpperCase(),
  );
}

export function scrapeStatusForTicker(ticker: string): ScrapeStatus | null {
  const db = ensureScraperDb();
  const row = db
    .prepare(`SELECT status FROM company_scrape WHERE ticker = ?`)
    .get(ticker.toUpperCase()) as { status: ScrapeStatus } | undefined;
  return row?.status ?? null;
}

const SETTLED_SCRAPE: ScrapeStatus[] = ["ok", "empty", "failed", "blocked"];

/** True when website scrape result is persisted — do not fetch again unless rescan. */
export function isWebsiteScrapeStored(
  ticker: string,
  scrapedAbout?: string | null,
): boolean {
  const text = (scrapedAbout ?? "").trim();
  if (text.length >= 80) return true;
  const status = scrapeStatusForTicker(ticker);
  return status != null && SETTLED_SCRAPE.includes(status);
}

export function storedWebsiteScrapeMeta(ticker: string): {
  status: ScrapeStatus;
  scraped_about: string | null;
  source_url: string | null;
} | null {
  const key = ticker.toUpperCase();

  const about = aboutDb();
  let fromAbout: string | null = null;
  if (about) {
    try {
      const row = about
        .prepare(`SELECT scraped_about FROM company_about WHERE ticker = ?`)
        .get(key) as { scraped_about: string | null } | undefined;
      fromAbout = row?.scraped_about?.trim() || null;
    } finally {
      about.close();
    }
  }

  if (!isWebsiteScrapeStored(key, fromAbout)) return null;

  const db = ensureScraperDb();
  const saved = db
    .prepare(
      `SELECT scraped_about, status, source_url FROM company_scrape WHERE ticker = ?`,
    )
    .get(key) as
    | {
        scraped_about: string | null;
        status: ScrapeStatus;
        source_url: string | null;
      }
    | undefined;

  const scraped =
    fromAbout ||
    saved?.scraped_about?.trim() ||
    null;
  const status =
    saved?.status ??
    (scraped && scraped.length >= 80 ? "ok" : "empty");

  return {
    status,
    scraped_about: scraped,
    source_url: saved?.source_url?.trim() || null,
  };
}

function rowStatus(
  scraped: string | null,
  scrapeStatus: ScrapeStatus | null,
  scrapeSource: string | null | undefined,
  yfAbout: string | null,
  manualAbout: string | null,
): ScrapeStatus {
  if (hasUsableYfAbout({ yf_about: yfAbout })) {
    if (scrapeSource === "website" && scrapeStatus === "ok") return "ok";
    return "covered";
  }
  if (hasUsableAboutText(manualAbout)) return "manual";
  if (scrapeSource === "yahoo") return "pending";
  if (scrapeStatus === "ok" && scrapeSource === "website" && scraped && scraped.length >= 80) {
    return "ok";
  }
  if (
    scrapeStatus === "failed" ||
    scrapeStatus === "empty" ||
    scrapeStatus === "blocked"
  ) {
    return scrapeStatus;
  }
  if (scraped && scraped.length >= 120 && scrapeSource === "website") return "ok";
  return "pending";
}

function isFilledStatus(status: ScrapeStatus): boolean {
  return status === "covered" || status === "ok" || status === "manual";
}

export function listScrapeRows(opts: {
  market?: string;
  filter?: ScrapeFilter;
  page?: number;
  pageSize?: number;
  sort?: "name" | "ticker" | "status";
  dir?: "asc" | "desc";
}): ScrapeListResult {
  const about = aboutDb();
  if (!about) {
    return {
      rows: [],
      total: 0,
      page: 1,
      pages: 0,
      stats: { pending: 0, ok: 0, failed: 0, covered: 0, todo: 0, with_web: 0 },
      markets: {},
    };
  }

  const db = ensureScraperDb();
  const seeded = db.prepare(`SELECT COUNT(*) AS c FROM company_scrape`).get() as {
    c: number;
  };
  if (!seeded.c) syncScraperFromCompanyAbout();
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(10, opts.pageSize ?? 50));
  const filter = opts.filter ?? "todo";
  const market = opts.market ?? "All";
  const sort = opts.sort ?? "name";
  const dir = opts.dir === "desc" ? "desc" : "asc";

  try {
    const base = about
      .prepare(
        `SELECT ticker, name, market, website, yf_about, about, scraped_about, website_status
         FROM company_about`,
      )
      .all() as Array<{
      ticker: string;
      name: string | null;
      market: string;
      website: string | null;
      yf_about: string | null;
      about: string | null;
      scraped_about: string | null;
      website_status: string | null;
    }>;

    const scrapeMap = new Map<
      string,
      {
        scraped_about: string | null;
        status: ScrapeStatus;
        error: string | null;
        char_count: number;
        scraped_at: string | null;
        source_url: string | null;
        scrape_source: string | null;
      }
    >();
    for (const r of db
      .prepare(
        `SELECT ticker, scraped_about, status, error, char_count, scraped_at, source_url, scrape_source FROM company_scrape`,
      )
      .all() as Array<{
      ticker: string;
      scraped_about: string | null;
      status: ScrapeStatus;
      error: string | null;
      char_count: number;
      scraped_at: string | null;
      source_url: string | null;
      scrape_source: "website" | null | string;
    }>) {
      scrapeMap.set(r.ticker.toUpperCase(), r);
    }

    const markets: Record<string, number> = {};
    const stats = {
      with_web: 0,
      pending: 0,
      ok: 0,
      failed: 0,
      covered: 0,
    };

    for (const r of base) {
      const key = r.ticker.toUpperCase();
      const saved = scrapeMap.get(key);
      const scraped =
        saved?.scraped_about?.trim() ||
        r.scraped_about?.trim() ||
        null;
      const status = rowStatus(
        scraped,
        saved?.status ?? null,
        saved?.scrape_source,
        r.yf_about,
        r.about,
      );

      if (!isFilledStatus(status)) {
        markets[r.market] = (markets[r.market] ?? 0) + 1;
      }

      if (market !== "All" && r.market !== market) continue;

      stats.with_web += 1;
      if (status === "pending") stats.pending += 1;
      else if (status === "ok") stats.ok += 1;
      else if (status === "covered") stats.covered += 1;
      else if (status === "manual") stats.covered += 1;
      else stats.failed += 1;
    }
    stats.todo = stats.pending + stats.failed;

    const merged: ScrapeRow[] = [];

    for (const r of base) {
      if (market !== "All" && r.market !== market) continue;

      const key = r.ticker.toUpperCase();
      const saved = scrapeMap.get(key);
      const scraped =
        saved?.scraped_about?.trim() ||
        r.scraped_about?.trim() ||
        null;
      const status = rowStatus(
        scraped,
        saved?.status ?? null,
        saved?.scrape_source,
        r.yf_about,
        r.about,
      );

      if (filter === "todo" && isFilledStatus(status)) continue;
      if (filter === "failed" && status !== "failed" && status !== "empty" && status !== "blocked") continue;

      merged.push({
        ticker: key,
        name: (r.name || key).trim(),
        market: r.market,
        website: r.website,
        web: websiteUrl(r.website),
        sc: screenerUrl(key),
        website_status: r.website_status,
        yf_about: r.yf_about?.trim() || null,
        about: r.about?.trim() || null,
        scraped_about: scraped,
        source_url: saved?.source_url ?? null,
        scrape_source: saved?.scrape_source === "website" ? "website" : null,
        status,
        error: saved?.error ?? null,
        char_count: scraped?.length ?? saved?.char_count ?? 0,
        scraped_at: saved?.scraped_at ?? null,
      });
    }

    merged.sort((a, b) => {
      let cmp = 0;
      if (sort === "ticker") cmp = a.ticker.localeCompare(b.ticker);
      else if (sort === "status") cmp = a.status.localeCompare(b.status);
      else cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      return dir === "desc" ? -cmp : cmp;
    });

    const total = merged.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const slice = merged.slice((page - 1) * pageSize, page * pageSize);

    return {
      rows: slice,
      total,
      page,
      pages,
      stats,
      markets,
    };
  } finally {
    about.close();
  }
}

export function getScrapeByTicker(ticker: string): ScrapeRow | null {
  const key = ticker.toUpperCase();
  const about = aboutDb();
  if (!about) return null;
  const db = ensureScraperDb();
  try {
    const row = about
      .prepare(
        `SELECT ticker, name, market, website, yf_about, about, scraped_about, website_status
         FROM company_about WHERE ticker = ?`,
      )
      .get(key) as
      | {
          ticker: string;
          name: string | null;
          market: string;
          website: string | null;
          yf_about: string | null;
          about: string | null;
          scraped_about: string | null;
          website_status: string | null;
        }
      | undefined;
    if (!row) return null;

    const saved = db
      .prepare(
        `SELECT scraped_about, status, error, char_count, scraped_at, source_url, scrape_source
         FROM company_scrape WHERE ticker = ?`,
      )
      .get(key) as
      | {
          scraped_about: string | null;
          status: ScrapeStatus;
          error: string | null;
          char_count: number;
          scraped_at: string | null;
          source_url: string | null;
          scrape_source: string | null;
        }
      | undefined;

    const scraped =
      saved?.scraped_about?.trim() || row.scraped_about?.trim() || null;
    const status = rowStatus(
      scraped,
      saved?.status ?? null,
      saved?.scrape_source,
      row.yf_about,
      row.about,
    );

    return {
      ticker: key,
      name: (row.name || key).trim(),
      market: row.market,
      website: row.website,
      web: websiteUrl(row.website),
      sc: screenerUrl(key),
      website_status: row.website_status,
      yf_about: row.yf_about?.trim() || null,
      about: row.about?.trim() || null,
      scraped_about: scraped,
      source_url: saved?.source_url ?? null,
      scrape_source: saved?.scrape_source === "website" ? "website" : null,
      status,
      error: saved?.error ?? null,
      char_count: scraped?.length ?? saved?.char_count ?? 0,
      scraped_at: saved?.scraped_at ?? null,
    };
  } finally {
    about.close();
  }
}

export function pendingScrapeCount(market = "All"): number {
  return listScrapeRows({ market, filter: "todo", page: 1, pageSize: 1 }).stats
    .todo;
}

/** Tickers with a website, no usable Yahoo about, and no successful scrape yet. */
export function pendingScrapeTickerSet(market = "All"): Set<string> {
  const about = aboutDb();
  if (!about) return new Set();
  const db = ensureScraperDb();
  syncScraperFromCompanyAbout();
  try {
    const scrapeMap = new Map<
      string,
      { status: ScrapeStatus; scrape_source: string | null }
    >();
    for (const r of db
      .prepare(`SELECT ticker, status, scrape_source FROM company_scrape`)
      .all() as Array<{
      ticker: string;
      status: ScrapeStatus;
      scrape_source: string | null;
    }>) {
      scrapeMap.set(r.ticker.toUpperCase(), r);
    }

    const pending = new Set<string>();
    const rows = about
      .prepare(
        `SELECT ticker, market, yf_about, about, TRIM(COALESCE(scraped_about, '')) AS scraped,
                TRIM(COALESCE(website, '')) AS website
         FROM company_about`,
      )
      .all() as Array<{
      ticker: string;
      market: string;
      yf_about: string | null;
      about: string | null;
      scraped: string;
      website: string;
    }>;

    for (const r of rows) {
      if (market !== "All" && r.market !== market) continue;
      const key = r.ticker.toUpperCase();
      if (hasUsableYfAbout({ yf_about: r.yf_about })) continue;
      if (hasUsableAboutText(r.about)) continue;

      const saved = scrapeMap.get(key);
      if (saved?.status === "ok" && saved?.scrape_source === "website") continue;
      if (!saved && r.scraped.length >= 120) continue;
      if (
        saved?.status === "failed" ||
        saved?.status === "empty" ||
        saved?.status === "blocked"
      ) {
        continue;
      }
      pending.add(key);
    }
    return pending;
  } finally {
    about.close();
  }
}
