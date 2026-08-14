/**
 * Full BSE SME sync into local DBs:
 *   - Universe + sector (BSE list + ComHeader APIs)
 *   - About + website + HQ (Yahoo `.BO` quoteSummary)
 *   - Price + mcap (BSE list cache + live LTP)
 *   - Classifications taxonomy
 *
 *   npm run sync:bse-sme
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { enrichBseAboutProfiles } from "../src/lib/bse-about";
import {
  BSE_SME_EXCLUDED,
  BSE_SME_MARKET,
  enrichBseSmeTaxonomy,
  fetchBseSmeListings,
  isBseSmeExcluded,
  type BseSmeListing,
} from "../src/lib/bse-sme";
import { invalidateCompanyCache } from "../src/lib/db";
import {
  fillBseSmeMetricsGaps,
  seedBseSmeMcapFromCache,
} from "../src/lib/metrics";

const DATA = path.join(process.cwd(), "data");
const ABOUT = path.join(DATA, "company_about.db");
const CLASS_PATH = path.join(DATA, "classifications.db");
const CACHE = path.join(DATA, "bse_sme_scrips.json");
const METRICS = path.join(DATA, "metrics.db");

function removeExcluded(): string[] {
  const removed: string[] = [];
  for (const ticker of BSE_SME_EXCLUDED) {
    if (fs.existsSync(ABOUT)) {
      const about = new Database(ABOUT);
      try {
        const r = about
          .prepare(
            `DELETE FROM company_about
             WHERE UPPER(ticker) = ? AND UPPER(market) = 'BSE SME'`,
          )
          .run(ticker);
        if (r.changes) removed.push(ticker);
      } finally {
        about.close();
      }
    }
    if (fs.existsSync(CLASS_PATH)) {
      const classDb = new Database(CLASS_PATH);
      try {
        classDb
          .prepare(
            `DELETE FROM classifications
             WHERE UPPER(ticker) = ? AND UPPER(COALESCE(market,'')) IN ('BSE', 'BSE SME')`,
          )
          .run(ticker);
      } finally {
        classDb.close();
      }
    }
    if (fs.existsSync(METRICS)) {
      const metrics = new Database(METRICS);
      try {
        metrics.prepare(`DELETE FROM stock_metrics WHERE UPPER(ticker) = ?`).run(ticker);
      } finally {
        metrics.close();
      }
    }
  }
  return removed;
}

function listingRowArgs(r: BseSmeListing, fetchedAt: string) {
  const about = r.about?.trim() || null;
  const website = r.website?.trim() || null;
  const headquarters = r.headquarters?.trim() || null;
  return {
    ticker: r.ticker,
    name: r.name,
    market: BSE_SME_MARKET,
    sector: r.sector,
    sub_sector: r.sub_sector || r.industry,
    about,
    website,
    headquarters,
    has_yf_about: about ? 1 : 0,
    has_website: website ? 1 : 0,
    fetched_at: fetchedAt,
  };
}

function tickersMissingAbout(tickers: string[]): Set<string> {
  if (!tickers.length || !fs.existsSync(ABOUT)) {
    return new Set(tickers.map((t) => t.toUpperCase()));
  }
  const db = new Database(ABOUT, { readonly: true });
  try {
    const have = new Set(
      (
        db
          .prepare(
            `SELECT UPPER(ticker) AS t FROM company_about
             WHERE UPPER(market) = 'BSE SME'
               AND (
                 TRIM(COALESCE(about, '')) != ''
                 OR TRIM(COALESCE(yf_about, '')) != ''
                 OR TRIM(COALESCE(scraped_about, '')) != ''
               )`,
          )
          .all() as Array<{ t: string }>
      ).map((r) => r.t),
    );
    return new Set(
      tickers.map((t) => t.toUpperCase()).filter((t) => !have.has(t)),
    );
  } finally {
    db.close();
  }
}

/** Copy stored about / web from company_about into listing cache rows. */
function hydrateAboutFromDb(listings: BseSmeListing[]): number {
  if (!listings.length || !fs.existsSync(ABOUT)) return 0;
  const db = new Database(ABOUT, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT ticker, about, yf_about, scraped_about, website, headquarters
         FROM company_about
         WHERE UPPER(market) = 'BSE SME'`,
      )
      .all() as Array<{
      ticker: string;
      about: string | null;
      yf_about: string | null;
      scraped_about: string | null;
      website: string | null;
      headquarters: string | null;
    }>;
    const byTicker = new Map(rows.map((r) => [r.ticker.toUpperCase(), r]));
    let n = 0;
    for (const r of listings) {
      const row = byTicker.get(r.ticker.toUpperCase());
      if (!row) continue;
      const about =
        row.about?.trim() ||
        row.yf_about?.trim() ||
        row.scraped_about?.trim() ||
        null;
      if (!r.about && about) r.about = about;
      if (!r.website && row.website?.trim()) r.website = row.website.trim();
      if (!r.headquarters && row.headquarters?.trim()) {
        r.headquarters = row.headquarters.trim();
      }
      if (r.about || r.website) n += 1;
    }
    return n;
  } finally {
    db.close();
  }
}

function upsertAbout(listings: BseSmeListing[]): {
  inserted: number;
  reclassified: number;
  updated: number;
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
        @ticker, @name, @market, @website, @about, @about, NULL,
        @sector, @sub_sector, @headquarters,
        NULL, NULL, NULL, 'bse-sme-sync', @fetched_at,
        @has_website, @has_yf_about, 0
      )
    `);
    const reclass = db.prepare(`
      UPDATE company_about
      SET market = @market,
          name = @name,
          company_sector = COALESCE(@sector, company_sector),
          company_industry = COALESCE(@sub_sector, company_industry),
          yf_about = COALESCE(@about, yf_about),
          about = COALESCE(NULLIF(TRIM(about), ''), @about),
          website = COALESCE(NULLIF(TRIM(website), ''), @website),
          headquarters = COALESCE(NULLIF(TRIM(headquarters), ''), @headquarters),
          has_yf_about = CASE WHEN @about IS NOT NULL THEN 1 ELSE has_yf_about END,
          has_website = CASE WHEN @website IS NOT NULL THEN 1 ELSE has_website END,
          source = 'bse-sme-sync',
          fetched_at = @fetched_at
      WHERE UPPER(ticker) = @ticker
        AND UPPER(COALESCE(market, '')) IN ('BSE', 'BSE SME')
    `);
    const refresh = db.prepare(`
      UPDATE company_about
      SET name = @name,
          company_sector = COALESCE(@sector, company_sector),
          company_industry = COALESCE(@sub_sector, company_industry),
          yf_about = COALESCE(@about, yf_about),
          about = COALESCE(NULLIF(TRIM(about), ''), @about),
          website = COALESCE(NULLIF(TRIM(website), ''), @website),
          headquarters = COALESCE(NULLIF(TRIM(headquarters), ''), @headquarters),
          has_yf_about = CASE WHEN @about IS NOT NULL THEN 1 ELSE has_yf_about END,
          has_website = CASE WHEN @website IS NOT NULL THEN 1 ELSE has_website END,
          source = 'bse-sme-sync',
          fetched_at = @fetched_at
      WHERE UPPER(ticker) = @ticker
        AND UPPER(market) = 'BSE SME'
    `);

    const now = new Date().toISOString();
    let inserted = 0;
    let reclassified = 0;
    let updated = 0;
    const skippedNse: string[] = [];

    const tx = db.transaction(() => {
      for (const r of listings) {
        const have = marketByTicker.get(r.ticker);
        const args = listingRowArgs(r, now);
        if (!have) {
          ins.run(args);
          inserted += 1;
          continue;
        }
        const mk = have.toUpperCase();
        if (mk === "BSE") {
          reclass.run(args);
          reclassified += 1;
          continue;
        }
        if (mk === "BSE SME") {
          refresh.run(args);
          updated += 1;
          continue;
        }
        skippedNse.push(`${r.ticker} (${have})`);
      }
    });
    tx();
    return { inserted, reclassified, updated, skippedNse };
  } finally {
    db.close();
  }
}

function upsertClassifications(listings: BseSmeListing[]): {
  filled: number;
  missing: number;
} {
  const classDb = new Database(CLASS_PATH);
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

    let filled = 0;
    const tx = classDb.transaction(() => {
      for (const r of listings) {
        if (!r.sector?.trim()) continue;
        del.run(r.ticker);
        ins.run(
          r.ticker,
          BSE_SME_MARKET,
          r.sector,
          r.industry,
          r.sub_sector || r.industry,
        );
        filled += 1;
      }
    });
    tx();
    return { filled, missing: listings.length - filled };
  } finally {
    classDb.close();
  }
}

async function main() {
  const purged = removeExcluded();
  if (purged.length) {
    console.log(`Removed excluded BSE SME: ${purged.join(", ")}`);
  }

  console.log("1) Fetch BSE SME scrips (groups M + MT)…");
  let listings = (await fetchBseSmeListings()).filter(
    (r) => !isBseSmeExcluded(r.ticker),
  );
  if (listings.length < 50) {
    throw new Error(`BSE SME fetch too small (${listings.length})`);
  }

  console.log(`2) Sector / industry from BSE ComHeader (${listings.length})…`);
  let lastPct = -1;
  listings = await enrichBseSmeTaxonomy(listings, {
    onProgress: (done) => {
      const pct = Math.floor((done / listings.length) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`  ${pct}%\r`);
      }
    },
  });
  process.stdout.write("\n");

  const synced = listings;
  const needAbout = tickersMissingAbout(synced.map((r) => r.ticker));
  if (needAbout.size) {
    console.log(`3) About / website for ${needAbout.size} names…`);
    lastPct = -1;
    const profiles = await enrichBseAboutProfiles([...needAbout], {
      onProgress: (done) => {
        const pct = Math.floor((done / needAbout.size) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          process.stdout.write(`  ${pct}%\r`);
        }
      },
    });
    process.stdout.write("\n");
    for (const r of listings) {
      const p = profiles.get(r.ticker.toUpperCase());
      if (!p) continue;
      r.about = p.about;
      r.website = p.website;
      r.headquarters = p.headquarters;
    }
    console.log(`   profiles fetched ${profiles.size}`);
  } else {
    console.log("3) About / website already complete — skip fetch");
  }
  hydrateAboutFromDb(listings);

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

  console.log("4) Upsert company_about.db + classifications…");
  const { inserted, reclassified, updated, skippedNse } = upsertAbout(listings);
  const inDb = listings.filter(
    (r) => !skippedNse.some((s) => s.startsWith(`${r.ticker} (`)),
  );
  const tax = upsertClassifications(inDb);

  const dbTickers = inDb.map((r) => r.ticker);
  console.log("5) Metrics (mcap cache + live LTP)…");
  const mcapSeed = seedBseSmeMcapFromCache(dbTickers);
  const metrics = await fillBseSmeMetricsGaps(
    dbTickers.map((ticker) => ({ ticker, market: BSE_SME_MARKET })),
  );
  invalidateCompanyCache();

  console.log(`Universe ${listings.length} BSE SME names`);
  console.log(`Inserted ${inserted} · reclassified ${reclassified} · refreshed ${updated}`);
  console.log(`Sector/sub-sector ${tax.filled} · taxonomy gaps ${tax.missing}`);
  console.log(
    `About+web ${listings.filter((r) => r.about?.trim()).length} / ${listings.length} in cache`,
  );
  console.log(
    `Metrics seeded ${mcapSeed} · filled price ${metrics.filledPrice} · mcap ${metrics.filledMcap}`,
  );
  if (skippedNse.length) {
    console.log(
      `Skipped ${skippedNse.length} already on NSE: ${skippedNse.join(", ")}`,
    );
  }
  console.log(`Cache ${CACHE}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
