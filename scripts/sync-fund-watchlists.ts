/**
 * Sync Niveshaay & Negen fund watchlists from stocks-ai into data/fund_watchlists.db.
 * Also upserts missing tickers into company_about.db (BSE names, etc.).
 *
 *   npm run sync:fund-watchlists
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { invalidateCompanyCache } from "../src/lib/db";
import {
  replaceFundWatchlists,
  type FundWatchlistKey,
} from "../src/lib/fund-watchlists";

const LISTS: FundWatchlistKey[] = ["niveshaay", "negen"];

const CANDIDATES = [
  path.join(process.cwd(), "..", "stocks-ai", "data", "stocks_ai.db"),
  path.join(
    process.env.HOME || "",
    "Development/ai.com/stocks-ai/data/stocks_ai.db",
  ),
];

function findSource(): string {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `stocks_ai.db not found. Tried:\n${CANDIDATES.map((p) => `  ${p}`).join("\n")}`,
  );
}

function upsertMissingAbout(
  src: Database.Database,
  rows: Array<{
    ticker: string;
    name: string | null;
    market: string | null;
  }>,
): number {
  const aboutPath = path.join(process.cwd(), "data", "company_about.db");
  if (!fs.existsSync(aboutPath)) {
    console.warn("company_about.db missing — skip universe upsert");
    return 0;
  }

  const about = new Database(aboutPath);
  try {
    const have = new Set(
      (
        about.prepare(`SELECT UPPER(ticker) AS t FROM company_about`).all() as Array<{
          t: string;
        }>
      ).map((r) => r.t),
    );

    const stockStmt = src.prepare(
      `SELECT ticker, name, market, sector, industry
       FROM stocks WHERE UPPER(ticker) = ? LIMIT 1`,
    );
    const ins = about.prepare(`
      INSERT INTO company_about (
        ticker, name, market, website, about, yf_about, scraped_about,
        company_sector, company_industry, headquarters,
        products, end_markets, theme_tags, source, fetched_at,
        has_website, has_yf_about, has_scraped_about
      ) VALUES (
        @ticker, @name, @market, NULL, NULL, NULL, NULL,
        @sector, @industry, NULL,
        NULL, NULL, NULL, 'fund-watchlist-sync', @fetched_at,
        0, 0, 0
      )
    `);
    const touch = about.prepare(`
      UPDATE company_about
      SET name = COALESCE(NULLIF(TRIM(@name), ''), name),
          market = COALESCE(NULLIF(TRIM(@market), ''), market),
          company_sector = COALESCE(NULLIF(TRIM(@sector), ''), company_sector),
          company_industry = COALESCE(NULLIF(TRIM(@industry), ''), company_industry),
          source = 'fund-watchlist-sync',
          fetched_at = @fetched_at
      WHERE UPPER(ticker) = @ticker
    `);

    const now = new Date().toISOString();
    let inserted = 0;
    let touched = 0;
    const tx = about.transaction(() => {
      for (const r of rows) {
        const ticker = (r.ticker || "").trim().toUpperCase();
        if (!ticker) continue;

        const stock = stockStmt.get(ticker) as
          | {
              ticker: string;
              name: string | null;
              market: string | null;
              sector: string | null;
              industry: string | null;
            }
          | undefined;

        const market = (stock?.market || r.market || "BSE").toUpperCase();
        const name = (stock?.name || r.name || ticker).trim();
        const sector = stock?.sector?.trim() || null;
        const industry = stock?.industry?.trim() || null;

        if (!have.has(ticker)) {
          ins.run({
            ticker,
            name,
            market,
            sector,
            industry,
            fetched_at: now,
          });
          have.add(ticker);
          inserted += 1;
        } else {
          const res = touch.run({
            ticker,
            name,
            market,
            sector,
            industry,
            fetched_at: now,
          });
          if (res.changes > 0) touched += 1;
        }
      }
    });
    tx();
    if (touched > 0) {
      console.log(`Updated ${touched} existing tickers in company_about.db`);
    }
    return inserted;
  } finally {
    about.close();
  }
}

function seedMetricsFromStocksAi(
  src: Database.Database,
  tickers: Set<string>,
): number {
  const metricsPath = path.join(process.cwd(), "data", "metrics.db");
  if (!fs.existsSync(metricsPath) || !tickers.size) return 0;

  const rows = src
    .prepare(
      `SELECT ticker, market, price, market_cap_cr, sector
       FROM stock_metrics
       WHERE price IS NOT NULL OR market_cap_cr IS NOT NULL`,
    )
    .all() as Array<{
    ticker: string;
    market: string | null;
    price: number | null;
    market_cap_cr: number | null;
    sector: string | null;
  }>;

  const metrics = new Database(metricsPath);
  try {
    const now = new Date().toISOString();
    const upsert = metrics.prepare(`
      INSERT INTO stock_metrics (ticker, market, yf_symbol, price, market_cap_cr, sector, fetched_at)
      VALUES (@ticker, @market, NULL, @price, @market_cap_cr, @sector, @fetched_at)
      ON CONFLICT(ticker) DO UPDATE SET
        market = COALESCE(excluded.market, stock_metrics.market),
        price = COALESCE(excluded.price, stock_metrics.price),
        market_cap_cr = COALESCE(excluded.market_cap_cr, stock_metrics.market_cap_cr),
        sector = COALESCE(excluded.sector, stock_metrics.sector),
        fetched_at = CASE
          WHEN excluded.price IS NOT NULL OR excluded.market_cap_cr IS NOT NULL
          THEN excluded.fetched_at ELSE stock_metrics.fetched_at END
    `);
    let seeded = 0;
    const tx = metrics.transaction(() => {
      for (const r of rows) {
        const ticker = r.ticker.toUpperCase();
        if (!tickers.has(ticker)) continue;
        upsert.run({
          ticker,
          market: r.market,
          price: r.price,
          market_cap_cr: r.market_cap_cr,
          sector: r.sector,
          fetched_at: now,
        });
        seeded += 1;
      }
    });
    tx();
    return seeded;
  } finally {
    metrics.close();
  }
}

function main() {
  const srcPath = findSource();
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  const allRows: Array<{
    ticker: string;
    name: string | null;
    market: string | null;
  }> = [];

  for (const listKey of LISTS) {
    const rows = src
      .prepare(
        `SELECT UPPER(ticker) AS ticker, MAX(name) AS name, MAX(market) AS market
         FROM fund_watchlists
         WHERE list_key = ?
         GROUP BY UPPER(ticker)
         ORDER BY ticker`,
      )
      .all(listKey) as Array<{
      ticker: string;
      name: string | null;
      market: string | null;
    }>;

    const n = replaceFundWatchlists(listKey, rows);
    console.log(
      `Synced ${n} ${listKey} tickers from ${srcPath} → data/fund_watchlists.db`,
    );
    console.log(rows.map((r) => r.ticker).join(", "));
    allRows.push(...rows);
  }

  const deduped = [
    ...new Map(allRows.map((r) => [r.ticker.toUpperCase(), r])).values(),
  ];
  const added = upsertMissingAbout(src, deduped);
  const metricsSeeded = seedMetricsFromStocksAi(
    src,
    new Set(deduped.map((r) => r.ticker.toUpperCase())),
  );
  src.close();

  invalidateCompanyCache();
  console.log(`Added ${added} missing tickers → data/company_about.db`);
  console.log(`Seeded ${metricsSeeded} fund watchlist metrics from stocks-ai`);
}

main();
