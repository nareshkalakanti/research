/**
 * Match corporate-event category keywords against clean About text in the DB.
 *
 *   npx tsx scripts/match-about-categories.ts
 *   npx tsx scripts/match-about-categories.ts --limit 50
 *   npx tsx scripts/match-about-categories.ts --market NSE --llm
 *   npx tsx scripts/match-about-categories.ts --ticker RELIANCE --llm
 *
 * Uses scraped_about_clean → llm_about → about.
 * Categories from data/corporate-event-keywords.json (1055 keywords).
 * Results → data/about_categories.db (UI: Categories tab).
 */
import fs from "fs";
import path from "path";
import { loadAllCompanies } from "../src/lib/db";
import {
  companiesWithCleanAbout,
  matchAboutCategoriesForCompany,
  saveAboutCategoryMatch,
  aboutCategoryStats,
  pickCleanAbout,
} from "../src/lib/about-category-match";
import { loadCorporateEventKeywords } from "../src/lib/corporate-event-keywords";
import { runConcurrent } from "../src/lib/scrape-pool";

function loadEnvLocal(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const num = (flag: string, fallback: number) => {
    const i = args.indexOf(flag);
    return i >= 0 ? Math.max(1, Number(args[i + 1]) || fallback) : fallback;
  };
  const str = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? String(args[i + 1] || "").trim() : "";
  };
  return {
    limit: args.includes("--limit") ? num("--limit", 50) : 0,
    market: str("--market") || "All",
    ticker: str("--ticker").toUpperCase(),
    llm: args.includes("--llm"),
    concurrency: Math.min(4, num("--concurrency", 2)),
  };
}

async function main() {
  loadEnvLocal();
  const opts = parseArgs();
  const file = loadCorporateEventKeywords();
  console.log(
    `Categories JSON: ${file.keywords.length} keywords · ${Object.keys(file.families || {}).length} families · focus ${file.concall_focus?.length ?? 0}`,
  );

  let companies = opts.ticker
    ? loadAllCompanies().filter((c) => c.ticker.toUpperCase() === opts.ticker)
    : companiesWithCleanAbout({
        market: opts.market,
        limit: opts.limit || undefined,
      });

  if (opts.ticker && !companies.length) {
    console.error(`Ticker not found: ${opts.ticker}`);
    process.exit(1);
  }
  if (!companies.length) {
    console.error("No companies with clean about text (≥80 chars).");
    process.exit(1);
  }

  console.log(
    `Matching ${companies.length} companies` +
      (opts.llm ? " with LLM refine" : " (lexical only)") +
      ` · market=${opts.market}`,
  );

  let done = 0;
  let withHits = 0;
  await runConcurrent(companies, opts.concurrency, async (c) => {
    const { source, text } = pickCleanAbout(c);
    const row = await matchAboutCategoriesForCompany(c, { llm: opts.llm });
    saveAboutCategoryMatch(row);
    done += 1;
    if (row.matches.length) withHits += 1;
    if (done % 25 === 0 || done === companies.length) {
      console.log(
        `  ${done}/${companies.length} · hits ${withHits} · last ${c.ticker} (${source}, ${text.length} chars, ${row.matches.length} tags)`,
      );
    }
  });

  const stats = aboutCategoryStats();
  console.log(
    `Done. DB tickers=${stats.tickers} with_matches=${stats.with_matches}. Open Categories tab in the app.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
