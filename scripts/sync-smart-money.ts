/**
 * Full smart-money sync — NSE+BSE deals, shareholding, news.
 * Usage: npm run sync:smart-money
 */
import { syncSmartMoneyData } from "../src/lib/smart-money/sync";
import { listShareholdingHits, listNewsSignals } from "../src/lib/smart-money/signals-store";
import { listDeals } from "../src/lib/bulk-deals/store";

async function main() {
  const days = Number(process.argv[2] || "30") || 30;
  console.log(`Syncing smart money data (${days}d)…\n`);

  const { loadShareholdingSeeds } = await import("../src/lib/smart-money/seeds");
  const { upsertShareholdingHits } = await import("../src/lib/smart-money/signals-store");
  upsertShareholdingHits(loadShareholdingSeeds());

  const result = await syncSmartMoneyData({
    days,
    skipShareholding: true,
    shareholdingMax: 8,
  });

  console.log("Deal sync:");
  console.log(`  NSE fetched: ${result.nse_fetched}`);
  console.log(`  BSE fetched: ${result.bse_fetched}`);
  console.log(`  Inserted/updated: ${result.deals_inserted}`);
  console.log(`  Total in DB: ${result.stats.total}`);
  console.log(`  Trilithon name matches: ${result.trilithon_deals}`);
  console.log(`  Devabhaktuni name matches: ${result.devabhaktuni_deals}`);

  console.log("\nShareholding:");
  console.log(`  Hits found: ${result.shareholding_hits}`);
  console.log(`  Stored: ${result.shareholding_stored}`);
  const sh = listShareholdingHits({ primaryOnly: true, limit: 20 });
  for (const h of sh) {
    console.log(
      `  ${h.symbol} ${h.holder_name} ${h.pct ?? "?"}% (${h.investor_ids.join(", ")})`,
    );
  }

  console.log("\nNews signals:");
  console.log(`  Found: ${result.news_signals} · stored: ${result.news_stored}`);
  for (const n of listNewsSignals({ primaryOnly: true, limit: 8 })) {
    console.log(`  · ${n.headline.slice(0, 72)}`);
  }

  const tril = listDeals({ days: 180, limit: 5000 }).filter((d) =>
    /trilithon|hidden gems/i.test(d.client_name),
  );
  console.log(`\nTrilithon bulk deals (${tril.length}):`);
  for (const d of tril.slice(0, 10)) {
    console.log(
      `  ${d.trade_date} ${d.exchange} ${d.symbol} ${d.side} ${d.client_name}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
