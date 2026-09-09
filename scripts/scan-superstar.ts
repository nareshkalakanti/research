/**
 * Pull latest Trendlyne superstar holdings → data/superstar_holdings.db
 *
 *   npm run scan:superstar
 *   npm run scan:superstar -- --limit 2
 */
import {
  listScanInvestors,
  scanInvestorBatch,
} from "../src/lib/superstars/scan";

async function main() {
  const idx = process.argv.indexOf("--limit");
  const batchLimit = Math.min(
    8,
    Math.max(1, Number(process.argv[idx + 1]) || 4),
  );
  const total = listScanInvestors().length;
  console.log(`Superstar scan · ${total} investors · batch ${batchLimit}`);

  let offset = 0;
  let saved = 0;
  while (offset < total) {
    const r = await scanInvestorBatch({
      offset,
      limit: batchLimit,
      includeFunds: true,
    });
    if (!r.ok) {
      console.error("batch failed:", r.error);
      process.exit(1);
    }
    saved += r.holdings_saved;
    for (const b of r.batch) {
      const err = b.error ? ` · ${b.error}` : "";
      console.log(
        `  ${b.short || b.name}: ${b.holdings} holdings (${b.sources} sources)${err}`,
      );
    }
    console.log(
      `  progress ${r.done}/${r.total} (${r.pct}%) · +${r.holdings_saved} this batch`,
    );
    offset = r.done;
    if (r.remaining <= 0) break;
  }
  console.log(`Done · ${saved} holdings saved → data/superstar_holdings.db`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
