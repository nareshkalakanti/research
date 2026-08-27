/**
 * Ensure fund watchlist rows in fund_watchlists.db exist in company_about.db.
 * Pull latest from Trendlyne first: npm run pull:fund-watchlists
 *
 *   npm run sync:fund-watchlists
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { invalidateCompanyCache } from "../src/lib/db";
import {
  ensureFundWatchlistInCompanyAbout,
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  fundWatchlistCounts,
  loadAllFundWatchlistRows,
} from "../src/lib/fund-watchlists";
import { resolveTickerMeta } from "./lib/local-ticker-meta";

function touchAboutFromLocal(): number {
  const rows = loadAllFundWatchlistRows();
  if (!rows.length) {
    console.log("fund_watchlists.db empty — nothing to sync");
    return 0;
  }

  const aboutPath = path.join(process.cwd(), "data", "company_about.db");
  if (!fs.existsSync(aboutPath)) {
    console.warn("company_about.db missing — skip");
    return 0;
  }

  const about = new Database(aboutPath);
  try {
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
    let touched = 0;
    const tx = about.transaction(() => {
      for (const r of rows) {
        const meta = resolveTickerMeta(r.ticker);
        const res = touch.run({
          ticker: r.ticker.toUpperCase(),
          name: meta.name,
          market: meta.market,
          sector: meta.sector,
          industry: meta.industry,
          fetched_at: now,
        });
        if (res.changes > 0) touched += 1;
      }
    });
    tx();
    if (touched > 0) {
      console.log(`Updated ${touched} existing tickers in company_about.db`);
    }
    return touched;
  } finally {
    about.close();
  }
}

function main() {
  const rows = loadAllFundWatchlistRows();
  const counts = fundWatchlistCounts();
  const parts = FUND_WATCHLIST_KEYS.map(
    (k) => `${counts[k]} ${FUND_WATCHLIST_LABELS[k].toLowerCase()}`,
  );
  console.log(
    `Local fund watchlists: ${parts.join(" · ")} · ${rows.length} unique tickers`,
  );

  const added = ensureFundWatchlistInCompanyAbout(rows);
  touchAboutFromLocal();
  invalidateCompanyCache();
  console.log(`Added ${added} missing tickers → company_about.db`);
}

main();
