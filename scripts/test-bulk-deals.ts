/**
 * Sync NSE bulk/block deals smoke test.
 * Usage: npx tsx scripts/test-bulk-deals.ts
 */
import { syncBulkDeals } from "../src/lib/bulk-deals/sync";
import { listDeals } from "../src/lib/bulk-deals/store";

async function main() {
  const days = Number(process.argv[2] || "14") || 14;
  console.log(`Syncing NSE bulk/block deals (last ${days} days)…`);
  const result = await syncBulkDeals({ days });
  console.log(JSON.stringify(result, null, 2));

  const smart = listDeals({ days, smartOnly: true, limit: 20 });
  console.log(`\nSmart-money deals (${smart.length}):`);
  for (const d of smart.slice(0, 10)) {
    console.log(
      `  ${d.trade_date} ${d.symbol} ${d.side} ${d.client_name} (${d.deal_type})`,
    );
  }

  const sme = listDeals({ days, limit: 500 }).filter((d) =>
    /-SM|ADISOFT|ATAM|AASTHA/i.test(d.symbol),
  );
  console.log(`\nSample SME-ish deals (${sme.length}):`);
  for (const d of sme.slice(0, 8)) {
    console.log(
      `  ${d.trade_date} ${d.symbol} ${d.side} ${d.client_name}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
