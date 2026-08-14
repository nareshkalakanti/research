/**
 * Sync official BSE SME (groups M + MT) into data/company_about.db.
 *
 * NSE SME comes from NSE Emerge CSV; this is the BSE equivalent.
 *
 *   npm run sync:bse-sme
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  BSE_SME_MARKET,
  fetchBseSmeListings,
  type BseSmeListing,
} from "../src/lib/bse-sme";

const DATA = path.join(process.cwd(), "data");
const ABOUT = path.join(DATA, "company_about.db");
const CLASS_PATH = path.join(DATA, "classifications.db");
const CACHE = path.join(DATA, "bse_sme_scrips.json");
const STOCKS_AI = path.join(
  process.cwd(),
  "..",
  "stocks-ai",
  "data",
  "stocks_ai.db",
);

function upsertAbout(listings: BseSmeListing[]): {
  inserted: number;
  reclassified: number;
  skippedNse: string[];
} {
  if (!fs.existsSync(ABOUT)) {
    throw new Error(`Missing ${ABOUT}`);
  }
  const db = new Database(ABOUT);
  try {
    const existing = db
      .prepare(`SELECT UPPER(ticker) AS t, market FROM company_about`)
      .all() as Array<{ t: string; market: string | null }>;
    const marketByTicker = new Map(
      existing.map((r) => [r.t, (r.market || "").trim()]),
    );

    const ins = db.prepare(`
      INSERT INTO company_about (
        ticker, name, market, website, about, yf_about, scraped_about,
        company_sector, company_industry, headquarters,
        products, end_markets, theme_tags, source, fetched_at,
        has_website, has_yf_about, has_scraped_about
      ) VALUES (
        @ticker, @name, @market, NULL, NULL, NULL, NULL,
        NULL, @industry, NULL,
        NULL, NULL, NULL, 'bse-sme-sync', @fetched_at,
        0, 0, 0
      )
    `);
    const reclass = db.prepare(`
      UPDATE company_about
      SET market = @market, source = 'bse-sme-sync', fetched_at = @fetched_at
      WHERE UPPER(ticker) = @ticker
        AND UPPER(COALESCE(market, '')) IN ('BSE', 'BSE SME')
    `);

    const now = new Date().toISOString();
    let inserted = 0;
    let reclassified = 0;
    const skippedNse: string[] = [];

    const tx = db.transaction(() => {
      for (const r of listings) {
        const have = marketByTicker.get(r.ticker);
        if (!have) {
          ins.run({
            ticker: r.ticker,
            name: r.name,
            market: BSE_SME_MARKET,
            industry: r.industry,
            fetched_at: now,
          });
          inserted += 1;
          continue;
        }
        const mk = have.toUpperCase();
        if (mk === "BSE") {
          reclass.run({
            ticker: r.ticker,
            market: BSE_SME_MARKET,
            fetched_at: now,
          });
          reclassified += 1;
          continue;
        }
        if (mk === "BSE SME") continue;
        skippedNse.push(`${r.ticker} (${have})`);
      }
    });
    tx();
    return { inserted, reclassified, skippedNse };
  } finally {
    db.close();
  }
}

type Taxonomy = {
  sector: string | null;
  industry: string | null;
  sub_sector: string | null;
};

function nonempty(s: string | null | undefined): string | null {
  const t = (s || "").trim();
  return t || null;
}

/** Copy sector / sub-sector from stocks-ai (same source NSE SME uses). */
function enrichTaxonomy(tickers: string[]): { filled: number; missing: number } {
  const want = new Set(tickers.map((t) => t.toUpperCase()));
  const tax = new Map<string, Taxonomy>();

  if (fs.existsSync(STOCKS_AI)) {
    const src = new Database(STOCKS_AI, { readonly: true, fileMustExist: true });
    try {
      const rows = src
        .prepare(
          `SELECT UPPER(ticker) AS t, sector, industry, sub_sector, market
           FROM stocks
           WHERE TRIM(COALESCE(sector, '')) != ''`,
        )
        .all() as Array<{
        t: string;
        sector: string | null;
        industry: string | null;
        sub_sector: string | null;
        market: string | null;
      }>;
      // Prefer BSE / BSE SME rows over NSE when the same ticker exists.
      const rank = (m: string | null) => {
        const x = (m || "").toUpperCase();
        if (x === "BSE SME") return 0;
        if (x === "BSE") return 1;
        return 2;
      };
      rows.sort((a, b) => rank(a.market) - rank(b.market));
      for (const r of rows) {
        if (!want.has(r.t) || tax.has(r.t)) continue;
        tax.set(r.t, {
          sector: nonempty(r.sector),
          industry: nonempty(r.industry),
          sub_sector: nonempty(r.sub_sector) || nonempty(r.industry),
        });
      }
    } finally {
      src.close();
    }
  }

  const classDb = new Database(CLASS_PATH);
  const about = new Database(ABOUT);
  try {
    classDb.exec(`
      CREATE TABLE IF NOT EXISTS classifications (
        ticker TEXT,
        market TEXT,
        sector TEXT,
        industry TEXT,
        sub_sector TEXT
      );
    `);
    const del = classDb.prepare(
      `DELETE FROM classifications
       WHERE UPPER(ticker) = ? AND UPPER(COALESCE(market,'')) IN ('BSE', 'BSE SME')`,
    );
    const ins = classDb.prepare(
      `INSERT INTO classifications (ticker, market, sector, industry, sub_sector)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const updAbout = about.prepare(
      `UPDATE company_about
       SET company_sector = COALESCE(NULLIF(TRIM(company_sector), ''), ?),
           company_industry = COALESCE(NULLIF(TRIM(company_industry), ''), ?)
       WHERE UPPER(ticker) = ? AND UPPER(market) = 'BSE SME'`,
    );

    let filled = 0;
    const tx = classDb.transaction(() => {
      const aboutTx = about.transaction(() => {
        for (const ticker of want) {
          const row = tax.get(ticker);
          if (!row?.sector) continue;
          del.run(ticker);
          ins.run(
            ticker,
            BSE_SME_MARKET,
            row.sector,
            row.industry,
            row.sub_sector,
          );
          updAbout.run(row.sector, row.sub_sector || row.industry, ticker);
          filled += 1;
        }
      });
      aboutTx();
    });
    tx();
    return { filled, missing: want.size - filled };
  } finally {
    classDb.close();
    about.close();
  }
}

async function main() {
  console.log("Fetching BSE SME scrips (groups M + MT)…");
  const listings = await fetchBseSmeListings();
  if (listings.length < 50) {
    throw new Error(`BSE SME fetch too small (${listings.length})`);
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(
    CACHE,
    JSON.stringify(
      {
        fetched_at: new Date().toISOString(),
        count: listings.length,
        listings,
      },
      null,
      2,
    ) + "\n",
  );
  const { inserted, reclassified, skippedNse } = upsertAbout(listings);
  const smeTickers = listings
    .filter((r) => !skippedNse.some((s) => s.startsWith(`${r.ticker} (`)))
    .map((r) => r.ticker);
  const tax = enrichTaxonomy(smeTickers);
  console.log(`Fetched ${listings.length} BSE SME names`);
  console.log(`Inserted ${inserted} into company_about.db`);
  console.log(`Reclassified ${reclassified} BSE → BSE SME`);
  console.log(
    `Sector/sub-sector filled ${tax.filled} · still missing ${tax.missing}`,
  );
  if (skippedNse.length) {
    console.log(
      `Skipped ${skippedNse.length} tickers already on NSE/NSE SME: ${skippedNse.join(", ")}`,
    );
  }
  console.log(`Cache ${CACHE}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
