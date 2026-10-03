/**
 *   npx tsx test/network-discovery.test.ts
 */
import assert from "node:assert/strict";
import {
  discoveryCompanySignals,
  discoveryMcapMatches,
  discoverySignalMatches,
  type DiscoveryCompanyRow,
} from "../src/lib/company-network";

const row = (over: Partial<DiscoveryCompanyRow> = {}): DiscoveryCompanyRow => ({
  ticker: "AAA",
  name: "AAA Limited",
  market_cap: 80,
  connected_companies: 1,
  directors: 1,
  board_directors: 2,
  largest_connected_mcap: 4000,
  cross_group: false,
  ...over,
});

assert.equal(discoveryMcapMatches(80, "all"), true);
assert.equal(discoveryMcapMatches(80, "lt100"), true);
assert.equal(discoveryMcapMatches(80, "b100_500"), false);
assert.equal(discoveryMcapMatches(300, "b100_500"), true);
assert.equal(discoveryMcapMatches(800, "b500_1000"), true);
assert.equal(discoveryMcapMatches(2000, "b1000_5000"), true);
assert.equal(discoveryMcapMatches(6000, "gte5000"), true);
assert.equal(discoveryMcapMatches(null, "lt100"), false);

assert.equal(discoverySignalMatches(row(), "all"), true);
assert.equal(discoverySignalMatches(row({ board_directors: 3 }), "boards3"), true);
assert.equal(discoverySignalMatches(row(), "boards3"), false);
assert.equal(
  discoverySignalMatches(row({ largest_connected_mcap: 5000 }), "c5k"),
  true,
);
assert.equal(
  discoverySignalMatches(row({ largest_connected_mcap: 10_000 }), "c10k"),
  true,
);
assert.equal(discoverySignalMatches(row({ cross_group: true }), "xgroup"), true);
assert.equal(
  discoverySignalMatches(row({ connected_companies: 2 }), "cos2"),
  true,
);
assert.equal(discoverySignalMatches(row({ directors: 2 }), "dirs2"), true);

assert.deepEqual(
  discoveryCompanySignals(
    row({
      board_directors: 4,
      largest_connected_mcap: 12_000,
      cross_group: true,
      connected_companies: 3,
    }),
  ),
  ["3+ Boards", "₹10k+ Connection", "Cross Group", "2+ Connections"],
);

console.log("network-discovery: ok");
