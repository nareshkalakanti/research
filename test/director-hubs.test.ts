/**
 * Director Hubs live checks against governance.db. Gold counts are the
 * validated current-board universe, not production special cases.
 */
import assert from "node:assert/strict";
import { loadDirectorHubs, loadNewConnections } from "../src/lib/company-network";

const hubs2 = loadDirectorHubs({ minBoards: 2, pageSize: 1 });
assert.equal(hubs2.summary.directors, 2328);
assert.equal(hubs2.summary.boards_3, 824);
assert.equal(hubs2.summary.boards_5, 155);
assert.equal(hubs2.summary.boards_7, 13);
assert.equal(hubs2.total, 2328);

const hubs3 = loadDirectorHubs({ minBoards: 3, pageSize: 50 });
assert.equal(hubs3.total, 824);
assert.ok(hubs3.rows.every((r) => r.boards >= 3));
assert.ok(hubs3.rows[0].boards >= hubs3.rows[hubs3.rows.length - 1].boards);
assert.ok(hubs3.rows.every((r) => r.new_connections >= 0));

const canonical = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: false,
  pageSize: 1,
});
assert.equal(canonical.total, 115);
assert.equal(canonical.summary.unique_directors, 70);

const withNew = loadDirectorHubs({ minBoards: 2, pageSize: 200 });
let newDirs = 0;
let newSum = 0;
for (let p = 1; p <= withNew.pages; p++) {
  const page = loadDirectorHubs({ minBoards: 2, page: p, pageSize: 200 });
  for (const r of page.rows) {
    if (r.new_connections > 0) {
      newDirs += 1;
      newSum += r.new_connections;
    }
  }
}
assert.equal(newDirs, 70);
assert.equal(newSum, 115);

const gap = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: false,
  aggregate: "gap",
  pageSize: 1,
});
assert.equal(gap.total, 65);

const multi = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: false,
  aggregate: "targets",
  minN10k: 2,
  pageSize: 1,
});
assert.equal(multi.total, 6);

console.log("director-hubs.test.ts ok");
