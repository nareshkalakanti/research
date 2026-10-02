/**
 *   npx tsx test/network-screen.test.ts
 */
import assert from "node:assert/strict";
import {
  compareScreenRows,
  screenRowMatches,
  type NetworkScreenRow,
} from "../src/lib/network-profile";

const row = (ticker: string, over: Partial<NetworkScreenRow> = {}): NetworkScreenRow => ({
  ticker,
  name: `${ticker} Limited`,
  market_cap: 100,
  cap_code: "MIC",
  group_keys: [],
  multi_company_directors: 1,
  same_group_directors: 0,
  cross_group_directors: 0,
  unclassified_directors: 1,
  max_mcap_ratio: 10,
  ...over,
});

const rows = [
  row("AAA", { max_mcap_ratio: 5 }),
  row("BBB", { max_mcap_ratio: null }),
  row("CCC", { max_mcap_ratio: 80 }),
];
const order = (key: Parameters<typeof compareScreenRows>[2], dir: "asc" | "desc") =>
  [...rows].sort((a, b) => compareScreenRows(a, b, key, dir)).map((r) => r.ticker);

assert.deepEqual(order("max_mcap_ratio", "desc"), ["CCC", "AAA", "BBB"], "null last when desc");
assert.deepEqual(order("max_mcap_ratio", "asc"), ["AAA", "CCC", "BBB"], "null last when asc");
assert.deepEqual(order("company", "asc"), ["AAA", "BBB", "CCC"]);
assert.deepEqual(order("company", "desc"), ["CCC", "BBB", "AAA"]);

const grouped = row("GRP", {
  group_keys: ["g1", "g2"],
  cap_code: "SC",
  cross_group_directors: 2,
  unclassified_directors: 0,
});
assert.equal(screenRowMatches(grouped, { group: "g2" }), true, "any of several groups");
assert.equal(screenRowMatches(grouped, { group: "g3" }), false);
assert.equal(screenRowMatches(grouped, { cap: "SC" }), true);
assert.equal(screenRowMatches(grouped, { cap: "MIC" }), false);
assert.equal(screenRowMatches(grouped, { connection: "cross_group" }), true);
assert.equal(screenRowMatches(grouped, { connection: "unclassified" }), false);
assert.equal(screenRowMatches(grouped, { connection: "same_group" }), false);
assert.equal(screenRowMatches(grouped, { connection: "any" }), true);
assert.equal(screenRowMatches(grouped, { q: "xyz" }), false);
assert.equal(screenRowMatches(grouped, { q: "grp" }), true, "ticker match");
assert.equal(screenRowMatches(grouped, { q: "limited" }), true, "name match");

console.log("network-screen: ok");
