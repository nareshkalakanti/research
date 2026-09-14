/**
 * MarketIQ pipeline smoke test: Get → Save → Extract → Analyse → DB.
 * Run: npm run test:marketiq-pipeline
 *
 * Uses one live announcement (or a provided PDF URL) and verifies each step.
 */
import assert from "assert";
import Database from "better-sqlite3";
import path from "path";
import {
  analyseMarketIqAnnouncement,
  discoverMarketIqAnnounced,
  extractMarketIqPdf,
  saveMarketIqHits,
  type MarketIqHit,
} from "../src/lib/marketiq-screen";

async function main() {
  const urlArg = process.argv[2]?.trim() || null;

  console.log("1/4 Get — discover announcements…");
  let hit: MarketIqHit | null = null;
  if (urlArg) {
    hit = {
      ticker: "TEST",
      company: null,
      title: "Pipeline test filing",
      url: urlArg,
      announced_at: new Date().toISOString().slice(0, 10),
      period: null,
      provider: "cli",
    };
  } else {
    const found = await discoverMarketIqAnnounced(2);
    const sources = (found.sources || []).filter((s) => s.url?.trim());
    assert.ok(sources.length > 0, "No live announcements with PDF URLs");
    hit = sources[0]!;
  }
  assert.ok(hit.url, "Need a PDF URL");
  console.log(`   → ${hit.ticker} · ${hit.title.slice(0, 80)}`);

  console.log("2/4 Save — write pending row to DB…");
  const saved = saveMarketIqHits([hit]);
  console.log(`   → saved ${saved} new row(s) (0 = already present)`);

  console.log("3/4 Extract — PDF text…");
  const extracted = await extractMarketIqPdf({
    url: hit.url,
    skipOcr: true,
  });
  assert.ok(
    extracted.ok !== false || (extracted.text?.length ?? 0) > 0,
    extracted.error || "Extract returned no text",
  );
  console.log(
    `   → engine=${extracted.engine} chars=${extracted.text_chars ?? extracted.text?.length ?? 0}`,
  );

  console.log("4/4 Analyse — score + save extract…");
  const analysed = await analyseMarketIqAnnouncement({
    url: hit.url,
    tickerHint: hit.ticker,
    companyHint: hit.company,
    titleHint: hit.title,
    announcedAt: hit.announced_at,
    allowHeadlineOnly: true,
    skipOcr: true,
  });
  assert.ok(analysed.ok, analysed.error || "Analyse failed");
  assert.ok(analysed.extract.category, "Missing category");
  assert.ok(analysed.extract.sentiment, "Missing sentiment");
  console.log(
    `   → ${analysed.extract.category} · ${analysed.extract.sentiment} · impact ${analysed.extract.impact} · id=${analysed.id}`,
  );

  const db = new Database(path.join("data", "marketiq.db"), {
    readonly: true,
    fileMustExist: true,
  });
  const row = db
    .prepare(
      `SELECT id, category, sentiment, impact, engine
       FROM announcement_screens
       WHERE source_url = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(hit.url) as
    | {
        id: number;
        category: string;
        sentiment: string;
        impact: number;
        engine: string;
      }
    | undefined;
  db.close();
  assert.ok(row, "Row missing from DB after analyse");
  assert.ok(
    row.sentiment && row.sentiment.toLowerCase() !== "pending",
    `Expected scored sentiment, got ${row.sentiment}`,
  );
  console.log(
    `ok · DB#${row.id} ${row.category} · ${row.sentiment} · impact ${row.impact} · ${row.engine}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
