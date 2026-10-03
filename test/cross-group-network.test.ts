/**
 * Cross-Group Network: current board_seats, no shared group_key, unique
 * (person_id, ticker_a, ticker_b). Gold counts from governance.db validation.
 */
import assert from "node:assert/strict";
import {
  loadCrossGroupNetwork,
  loadDirectorHubs,
  loadNewConnections,
} from "../src/lib/company-network";

const groups = loadCrossGroupNetwork({ pane: "groups", pageSize: 50 });
assert.equal(groups.summary.relationships, 626);
assert.equal(groups.summary.directors, 327);
assert.equal(groups.summary.companies, 375);
assert.equal(groups.summary.group_pairs, 410);
assert.equal(groups.summary.groups, 152);
assert.equal(groups.total, 410);
assert.ok(groups.pairs.every((r) => r.group_a_key < r.group_b_key));
assert.ok(groups.pairs.every((r) => r.group_a_key !== r.group_b_key));

const companies = loadCrossGroupNetwork({ pane: "companies", pageSize: 1 });
assert.equal(companies.total, 375);
const directors = loadCrossGroupNetwork({ pane: "directors", pageSize: 1 });
assert.equal(directors.total, 327);

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

const gap = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: false,
  aggregate: "gap",
  pageSize: 1,
});
assert.equal(gap.total, 65);
assert.equal(gap.summary.edges, 115);
assert.equal(gap.summary.n_10k_connections, 31);
assert.equal(gap.summary.n_25k_connections, 12);
assert.equal(gap.summary.mega_connections, 5);
assert.equal(gap.summary.cross_group, 8);

const multi = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: false,
  aggregate: "targets",
  minN10k: 2,
  pageSize: 1,
});
assert.equal(multi.total, 6);
assert.equal(
  loadNewConnections({
    days: 180,
    maxTargetMcap: 5000,
    connection: "cross_group",
    pageSize: 1,
  }).total,
  8,
);
assert.equal(
  loadNewConnections({
    days: 180,
    maxTargetMcap: 5000,
    minConnectedMcap: 10000,
    pageSize: 1,
  }).total,
  31,
);
assert.equal(
  loadNewConnections({
    days: 180,
    maxTargetMcap: 5000,
    minBoards: 3,
    pageSize: 1,
  }).total,
  62,
);

const hubs3 = loadDirectorHubs({ minBoards: 3, pageSize: 1 });
assert.equal(hubs3.total, 824);
assert.equal(hubs3.summary.directors, 2328);

console.log("cross-group-network.test.ts ok");
