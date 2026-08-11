/**
 * Quick Hidden Portfolio smoke test (2–3 symbols).
 * Usage: npx tsx scripts/test-hidden-portfolio.ts
 */
import { runHiddenPortfolioScan } from "../src/lib/hidden-portfolio/run";

async function main() {
  const symbols = process.argv.slice(2);
  const list =
    symbols.length > 0
      ? symbols
      : ["ATAM.NS", "PATELENG.NS", "PREMEXPLN.NS"];

  console.log("Hidden Portfolio smoke test:", list.join(", "));
  const result = await runHiddenPortfolioScan({
    symbols: list,
    force: true,
    writeReport: true,
    includeDbSme: false,
    onProgress: (p) => {
      console.log(`  [${p.done}/${p.total}] ${p.symbol}: ${p.status}`);
    },
  });

  console.log("\n--- summary ---");
  console.log("universe:", result.universe_count);
  console.log("filtered:", result.filtered_count);
  console.log("skipped:", result.skipped.length);
  for (const s of result.skipped) {
    console.log(`  skip ${s.symbol}: ${s.reason}`);
  }
  console.log("report:", result.report_path);

  console.log("\n--- candidates ---");
  for (const c of result.candidates) {
    console.log(
      JSON.stringify(
        {
          symbol: c.symbol,
          name: c.name,
          price: c.price,
          mcap_cr: c.mcap_cr,
          alpha_score: c.alpha_score,
          moat: c.moat_keywords,
          growth: c.growth_keywords,
          smart_money: c.smart_money_flag,
          headline: c.top_headline,
          link: c.top_link,
        },
        null,
        2,
      ),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
