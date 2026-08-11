/**
 * Smoke test: smart money radar aggregation.
 * Usage: npm run test:smart-money
 */
import { buildSmartMoneyRadar } from "../src/lib/smart-money/radar";

const radar = buildSmartMoneyRadar({ days: 90, primaryOnly: true, limit: 20 });

console.log("SME universe:", radar.sme_universe_count);
console.log("Total deals in DB:", radar.total_deals);
console.log("Primary hits:", radar.primary_deals);
console.log("SME + primary:", radar.sme_smart_deals);
console.log("\nInvestor stats:");
for (const inv of radar.investors) {
  if (inv.primary || inv.deal_count > 0) {
    console.log(
      `  ${inv.label}: ${inv.deal_count} deals, ${inv.buy_count} buys, ${inv.sme_count} SME`,
    );
  }
}
console.log("\nDeals shown:", radar.deals.length);
if (radar.sme_hits.length) {
  console.log("SME hits:", radar.sme_hits.slice(0, 5));
}
