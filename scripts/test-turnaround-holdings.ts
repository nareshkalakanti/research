/**
 * Scan 8 turnaround holdings through hidden portfolio pipeline.
 * Usage: npx tsx scripts/test-turnaround-holdings.ts
 */
import { loadTurnaroundHoldings, turnaroundScanSymbols } from "../src/lib/turnaround-holdings";
import { runHiddenPortfolioScan } from "../src/lib/hidden-portfolio/run";

async function main() {
  const holdings = loadTurnaroundHoldings();
  console.log("Turnaround holdings:", holdings.length);
  for (const h of holdings) {
    console.log(`  ${h.ticker} · ${h.name} · ${h.yahoo_symbol}`);
  }

  const symbols = turnaroundScanSymbols();
  console.log("\nScanning…");
  const result = await runHiddenPortfolioScan({
    symbols,
    force: true,
    writeReport: true,
    onProgress: (p) =>
      console.log(`  [${p.done}/${p.total}] ${p.symbol}: ${p.status}`),
  });

  console.log("\n--- results ---");
  console.log("filtered:", result.filtered_count, "skipped:", result.skipped.length);
  for (const c of result.candidates.sort((a, b) => b.alpha_score - a.alpha_score)) {
    console.log(
      `${c.symbol.padEnd(12)} α=${String(c.alpha_score).padStart(3)} mcap=${c.mcap_cr ?? "—"} growth=${c.growth_keywords.join("|") || "—"} smart=${c.smart_money_flag ? "Y" : "—"}`,
    );
    if (c.top_headline) console.log(`    → ${c.top_headline.slice(0, 90)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
