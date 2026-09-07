/**
 * Seed SOIC watchlist (Q1 FY27 Fastest Growing) into soic.db + company_about.
 *
 *   npm run sync:soic
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { invalidateCompanyCache } from "../src/lib/db";
import { replaceSoic } from "../src/lib/soic";
import { resolveTickerMeta } from "./lib/local-ticker-meta";

type SeedRow = { ticker: string; name?: string; market?: string };

function main() {
  const seedPath = path.join(process.cwd(), "data", "soic-q1fy27.json");
  if (!fs.existsSync(seedPath)) {
    console.error("Missing data/soic-q1fy27.json");
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as SeedRow[];
  const n = replaceSoic(
    seed.map((r) => ({
      ticker: r.ticker,
      name: r.name,
      market: r.market || "NSE",
      sources: "soic_q1fy27",
    })),
  );
  console.log(`soic.db ← ${n} tickers (SOIC × StockScans Q1 FY27)`);

  const aboutPath = path.join(process.cwd(), "data", "company_about.db");
  if (!fs.existsSync(aboutPath)) {
    console.warn("company_about.db missing — skip about upsert");
    return;
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
        NULL, NULL, NULL, 'soic-sync', @fetched_at,
        0, 0, 0
      )
    `);
    const now = new Date().toISOString();
    let inserted = 0;
    const tx = about.transaction(() => {
      for (const r of seed) {
        const ticker = r.ticker.toUpperCase();
        if (have.has(ticker)) continue;
        const meta = resolveTickerMeta(ticker);
        ins.run({
          ticker,
          name: r.name?.trim() || meta.name || ticker,
          market: (r.market || meta.market || "NSE").toUpperCase(),
          sector: meta.sector,
          industry: meta.industry,
          fetched_at: now,
        });
        have.add(ticker);
        inserted += 1;
      }
    });
    tx();
    console.log(`company_about: inserted ${inserted} missing rows`);
  } finally {
    about.close();
    invalidateCompanyCache();
  }
}

main();
