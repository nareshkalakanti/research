/**
 * Ensure Early Edge tickers in edge.db exist in company_about.db (local only).
 *
 *   npm run sync:edge
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { invalidateCompanyCache } from "../src/lib/db";
import { loadEdge } from "../src/lib/edge";
import { resolveTickerMeta } from "./lib/local-ticker-meta";

function upsertMissingAbout(): number {
  const edgeRows = loadEdge();
  if (!edgeRows.length) {
    console.log("edge.db empty — nothing to sync");
    return 0;
  }

  const aboutPath = path.join(process.cwd(), "data", "company_about.db");
  if (!fs.existsSync(aboutPath)) {
    console.warn("company_about.db missing — skip");
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
    const ins = about.prepare(`
      INSERT INTO company_about (
        ticker, name, market, website, about, yf_about, scraped_about,
        company_sector, company_industry, headquarters,
        products, end_markets, theme_tags, source, fetched_at,
        has_website, has_yf_about, has_scraped_about
      ) VALUES (
        @ticker, @name, @market, NULL, NULL, NULL, NULL,
        @sector, @industry, NULL,
        NULL, NULL, NULL, 'edge-sync', @fetched_at,
        0, 0, 0
      )
    `);
    const touch = about.prepare(`
      UPDATE company_about
      SET name = COALESCE(NULLIF(TRIM(@name), ''), name),
          market = COALESCE(NULLIF(TRIM(@market), ''), market),
          company_sector = COALESCE(NULLIF(TRIM(@sector), ''), company_sector),
          company_industry = COALESCE(NULLIF(TRIM(@industry), ''), company_industry),
          source = 'edge-sync',
          fetched_at = @fetched_at
      WHERE UPPER(ticker) = @ticker
    `);
    const now = new Date().toISOString();
    let inserted = 0;
    let touched = 0;
    const tx = about.transaction(() => {
      for (const r of edgeRows) {
        const meta = resolveTickerMeta(r.ticker);
        const name = r.name?.trim() || meta.name;
        const market = (r.market || meta.market).toUpperCase();
        const ticker = r.ticker.toUpperCase();
        if (!have.has(ticker)) {
          ins.run({
            ticker,
            name,
            market,
            sector: meta.sector,
            industry: meta.industry,
            fetched_at: now,
          });
          have.add(ticker);
          inserted += 1;
        } else {
          const res = touch.run({
            ticker,
            name,
            market,
            sector: meta.sector,
            industry: meta.industry,
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

function main() {
  const rows = loadEdge();
  console.log(`Local Edge watchlist: ${rows.length} tickers`);
  const added = upsertMissingAbout();
  invalidateCompanyCache();
  console.log(`Added ${added} missing tickers → data/company_about.db`);
  console.log(rows.map((r) => r.ticker).join(", "));
}

main();
