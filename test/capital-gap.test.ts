/**
 * Capital Gap aggregates the canonical new_edges set (fixture gold in
 * company-network.test.ts; this file checks the live governance.db loader).
 */
import assert from "node:assert/strict";
import { loadNewConnections } from "../src/lib/company-network";

const canonical = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: false,
  pageSize: 1,
});
assert.equal(canonical.total, 115);
assert.equal(canonical.summary.unique_targets, 65);
assert.equal(canonical.summary.unique_directors, 70);
assert.equal(canonical.summary.cross_group, 8);
assert.equal(canonical.summary.mega_connections, 5);

const gap = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: false,
  aggregate: "gap",
  pageSize: 200,
});
assert.equal(gap.total, 65);
assert.equal(gap.summary.edges, 115);
assert.equal(gap.summary.unique_targets, 65);
assert.equal(gap.summary.cross_group, 8);
assert.equal(gap.summary.mega_connections, 5);
assert.equal(gap.summary.n_10k_connections, 31);
assert.equal(gap.summary.n_25k_connections, 12);
assert.ok(gap.targets.every((r) => (r.target_market_cap ?? 0) > 0));
assert.ok(gap.targets.every((r) => (r.target_market_cap ?? 0) < 5000));
assert.ok(
  gap.targets.every(
    (r) => r.multi_board_director_count >= 1 && r.connected_companies >= 1,
  ),
);
const max = [...gap.targets].sort(
  (a, b) => (b.largest_ratio ?? 0) - (a.largest_ratio ?? 0),
)[0];
assert.equal(max.largest_ratio, 947.5);

const former = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: true,
  pageSize: 1,
});
assert.notEqual(former.total, gap.summary.edges);

const multi = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: false,
  aggregate: "targets",
  minN10k: 2,
  pageSize: 200,
});
assert.equal(multi.total, 6);

console.log("capital-gap.test.ts ok");
