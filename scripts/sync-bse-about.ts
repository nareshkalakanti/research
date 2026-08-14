/**
 * Fill only missing BSE SME about / website rows.
 * Full sync (universe + taxonomy + about + metrics): npm run sync:bse-sme
 *
 *   npm run sync:bse-about
 */
import Database from "better-sqlite3";
import path from "path";
import { enrichBseAboutProfiles } from "../src/lib/bse-about";
import { BSE_SME_MARKET, isBseSmeExcluded } from "../src/lib/bse-sme";
import { invalidateCompanyCache } from "../src/lib/db";

const ABOUT = path.join(process.cwd(), "data", "company_about.db");

function pendingTickers(limit: number): string[] {
  const db = new Database(ABOUT, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT ticker FROM company_about
         WHERE UPPER(market) = 'BSE SME'
           AND TRIM(COALESCE(about, '')) = ''
           AND TRIM(COALESCE(yf_about, '')) = ''
           AND TRIM(COALESCE(scraped_about, '')) = ''
         ORDER BY ticker COLLATE NOCASE`,
      )
      .all() as Array<{ ticker: string }>;
    return rows
      .map((r) => r.ticker.toUpperCase())
      .filter((t) => !isBseSmeExcluded(t))
      .slice(0, limit);
  } finally {
    db.close();
  }
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith("--limit"));
  const limit = limitArg
    ? Math.max(
        1,
        Number(
          limitArg.split("=")[1] ||
            process.argv[process.argv.indexOf("--limit") + 1],
        ),
      )
    : 10_000;

  const tickers = pendingTickers(limit);
  if (!tickers.length) {
    console.log("No BSE SME rows missing about text.");
    return;
  }

  console.log(`Filling about/web for ${tickers.length} BSE SME names…`);
  const profiles = await enrichBseAboutProfiles(tickers, {
    market: BSE_SME_MARKET,
    onProgress: (done) => {
      if (done % 25 === 0 || done === tickers.length) {
        process.stdout.write(`  ${done}/${tickers.length}\r`);
      }
    },
  });
  process.stdout.write("\n");

  const db = new Database(ABOUT);
  const upd = db.prepare(`
    UPDATE company_about
    SET yf_about = @about,
        about = COALESCE(NULLIF(TRIM(about), ''), @about),
        website = COALESCE(NULLIF(TRIM(website), ''), @website),
        headquarters = COALESCE(NULLIF(TRIM(headquarters), ''), @headquarters),
        has_yf_about = CASE WHEN @about IS NOT NULL THEN 1 ELSE has_yf_about END,
        has_website = CASE WHEN @website IS NOT NULL THEN 1 ELSE has_website END,
        source = 'bse-about-sync',
        fetched_at = @fetched_at
    WHERE UPPER(ticker) = @ticker AND UPPER(market) = 'BSE SME'
  `);

  const now = new Date().toISOString();
  let filledAbout = 0;
  let filledWeb = 0;
  const tx = db.transaction(() => {
    for (const [ticker, profile] of profiles) {
      upd.run({
        ticker,
        about: profile.about,
        website: profile.website,
        headquarters: profile.headquarters,
        fetched_at: now,
      });
      if (profile.about) filledAbout += 1;
      if (profile.website) filledWeb += 1;
    }
  });
  tx();
  db.close();
  invalidateCompanyCache();

  console.log(
    `About filled ${filledAbout} · website ${filledWeb} · missed ${tickers.length - profiles.size}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
