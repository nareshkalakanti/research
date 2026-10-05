/**
 * Holdings tab: one graph per personal holding ticker.
 */
import assert from "node:assert/strict";
import { loadHoldings } from "../src/lib/holdings";
import { loadHoldingCompanyMaps } from "../src/lib/governance-map";

const held = new Set(loadHoldings().map((h) => h.ticker.toUpperCase()));
const maps = loadHoldingCompanyMaps({ refresh: true });
for (const g of maps) {
  assert.equal(g.company_count, 1, g.family_name);
  const t = g.companies[0]?.ticker.toUpperCase();
  assert.ok(t && held.has(t), t);
}
