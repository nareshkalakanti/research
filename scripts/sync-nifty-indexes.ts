/**
 * Pull Nifty 200 / Nifty 500 constituents from NSE archives into
 * data/index_constituents.db, and upsert any missing tickers into company_about.
 *
 *   npm run sync:nifty-indexes
 *   npm run sync:nifty-indexes -- --force
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { invalidateCompanyCache } from "../src/lib/db";
import {
  ensureIndexConstituents,
  loadIndexConstituents,
  NIFTY_INDEX_IDS,
  NIFTY_INDEX_META,
  type NiftyIndexId,
} from "../src/lib/nse-index-constituents";
import { resolveTickerMeta } from "./lib/local-ticker-meta";

const force = process.argv.includes("--force");

async function upsertMissingAbout(indexId: NiftyIndexId): Promise<number> {
  const rows = loadIndexConstituents(indexId);
  if (!rows.length) return 0;

  const aboutPath = path.join(process.cwd(), "data", "company_about.db");
  if (!fs.existsSync(aboutPath)) {
    console.warn("company_about.db missing — skip upsert");
    return 0;
  }

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
        NULL, @industry, NULL,
        NULL, NULL, NULL, 'nifty-index', @fetched_at,
        0, 0, 0
      )
    `);
    let n = 0;
    const now = new Date().toISOString();
    const tx = about.transaction(() => {
      for (const r of rows) {
        const ticker = r.ticker.toUpperCase();
        if (have.has(ticker)) continue;
        const meta = resolveTickerMeta(ticker);
        ins.run({
          ticker,
          name: r.name || meta?.name || ticker,
          market: meta?.market || "NSE",
          industry: r.industry || null,
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

async function main() {
  for (const id of NIFTY_INDEX_IDS) {
    const label = NIFTY_INDEX_META[id].label;
    const result = await ensureIndexConstituents(id, { force });
    const added = await upsertMissingAbout(id);
    console.log(
      `${label}: ${result.count} constituents` +
        (result.refreshed ? " (refreshed)" : " (cached)") +
        (added ? `, +${added} about rows` : "") +
        (result.error ? ` · warn: ${result.error}` : ""),
    );
  }
  invalidateCompanyCache();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
