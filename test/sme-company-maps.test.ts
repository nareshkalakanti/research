/**
 * SME tab: one graph per SME listing that already has board seats.
 */
import assert from "node:assert/strict";
import { loadSmeCompanyMaps } from "../src/lib/governance-map";

const maps = loadSmeCompanyMaps({ refresh: true });
assert.ok(maps.length >= 1, "need at least one seated SME listing");
for (const g of maps) {
  assert.equal(g.company_count, 1, g.family_name);
  assert.equal(g.companies.length, 1, g.family_name);
  const hub = g.companies[0]!;
  assert.ok(hub.is_sme, hub.ticker);
  assert.ok(
    hub.market === "NSE SME" || hub.market === "BSE SME",
    `${hub.ticker} market=${hub.market}`,
  );
  assert.equal(
    (g.outside ?? []).some((o) => o.ticker.toUpperCase() === hub.ticker.toUpperCase()),
    false,
    hub.ticker,
  );
}
