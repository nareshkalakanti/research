/**
 * Group Mapping Review: detection, preview, and safe company_groups writes.
 */
import assert from "node:assert/strict";
import {
  loadCrossGroupNetwork,
  loadDirectorHubs,
  loadNetworkClusters,
  loadNewConnections,
} from "../src/lib/company-network";
import {
  applyMappingChange,
  countTable,
  groupNameReviewReason,
  loadGroupMappingReview,
  networkPairStats,
  previewMappingChange,
} from "../src/lib/group-mapping-review";
import { openSqliteNamed } from "../src/lib/sqlite-utils";

assert.ok(groupNameReviewReason("Electronics"));
assert.ok(groupNameReviewReason("Petroleum"));
assert.equal(groupNameReviewReason("Tata Group"), null);

const review = loadGroupMappingReview({ pageSize: 200 });
assert.equal(review.summary.groups, 208);
assert.equal(review.summary.companies, 664);
assert.equal(review.summary.multi_group_companies, 10);
assert.ok(review.summary.review_candidates >= 10);
assert.equal(review.summary.company_pairs, 5013);
assert.equal(review.summary.same_group_pairs, 529);
assert.equal(review.summary.cross_group_pairs, 597);

const allMulti = loadGroupMappingReview({ kind: "multi_group", pageSize: 50 });
assert.equal(allMulti.total, 10);
assert.ok(allMulti.rows.every((r) => !!r.ticker));

assert.ok(review.merges.length >= 1);
assert.ok(review.merges.every((m) => m.group_a_key !== m.group_b_key));

const stats = networkPairStats();
assert.equal(stats.company_pairs, 5013);
assert.equal(stats.same_group_pairs, 529);
assert.equal(stats.cross_group_pairs, 597);
assert.equal(
  stats.unclassified_pairs,
  stats.company_pairs - stats.same_group_pairs - stats.cross_group_pairs,
);

const sample = allMulti.rows[0];
assert.ok(sample.ticker);

const db = openSqliteNamed("governance.db", { wal: true });
const ticker = sample.ticker!;
const memberships = db
  .prepare(
    `SELECT group_key, group_name FROM company_groups WHERE ticker = ? ORDER BY group_key`,
  )
  .all(ticker) as Array<{ group_key: string; group_name: string }>;
assert.ok(memberships.length >= 2);
const removeKey = memberships[0].group_key;
const keepKey = memberships[1].group_key;

const seats0 = countTable(db, "board_seats");
const events0 = countTable(db, "board_seat_events");
const dirs0 = countTable(db, "directors");
const cos0 = countTable(db, "companies");
const met0 = countTable(db, "company_metrics");
const cg0 = countTable(db, "company_groups");

const denied = applyMappingChange(
  { action: "remove", ticker, group_key: removeKey },
  { confirm: false, db },
);
assert.equal(denied.company_groups_changed, 0);
assert.equal(denied.committed, false);
assert.equal(countTable(db, "company_groups"), cg0);

const stale = applyMappingChange(
  {
    action: "remove",
    ticker,
    group_key: removeKey,
    expected_group_name: "not-the-reviewed-group-name",
  },
  { confirm: true, db },
);
assert.equal(stale.committed, false);
assert.match(stale.message, /Conflict|Fresh review|group_name/i);
assert.equal(countTable(db, "company_groups"), cg0);

const badTarget = applyMappingChange(
  {
    action: "reassign",
    ticker,
    group_key: removeKey,
    new_group_key: "group-key-that-does-not-exist",
    expected_group_name: memberships[0].group_name,
  },
  { confirm: true, db },
);
assert.equal(badTarget.committed, false);
assert.match(badTarget.message, /does not exist/i);
assert.equal(countTable(db, "company_groups"), cg0);

const keysBefore = (
  db.prepare(`SELECT DISTINCT group_key FROM company_groups`).all() as Array<{
    group_key: string;
  }>
).length;

const previewOnce = previewMappingChange({
  action: "remove",
  ticker,
  group_key: removeKey,
});
const previewTwice = previewMappingChange({
  action: "remove",
  ticker,
  group_key: removeKey,
});
assert.deepEqual(previewOnce.after, previewTwice.after);
assert.equal(previewOnce.before.company_pairs, 5013);

db.exec("BEGIN");
try {
  const applied = applyMappingChange(
    {
      action: "remove",
      ticker,
      group_key: removeKey,
      expected_group_name: memberships[0].group_name,
    },
    { confirm: true, db },
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.committed, true);
  assert.equal(applied.removed, 1);
  assert.equal(applied.reassigned, 0);
  assert.equal(applied.added, 0);
  assert.equal(applied.company_groups_changed, 1);
  assert.equal(applied.after?.company_pairs, 5013);
  assert.equal(applied.before?.company_pairs, 5013);
  const remaining = db
    .prepare(`SELECT group_key FROM company_groups WHERE ticker = ?`)
    .all(ticker) as Array<{ group_key: string }>;
  assert.ok(remaining.some((r) => r.group_key === keepKey));
  assert.ok(!remaining.some((r) => r.group_key === removeKey));
  assert.equal(remaining.length, memberships.length - 1);
  assert.equal(countTable(db, "board_seats"), seats0);
  assert.equal(countTable(db, "board_seat_events"), events0);
  assert.equal(countTable(db, "directors"), dirs0);
  assert.equal(countTable(db, "companies"), cos0);
  assert.equal(countTable(db, "company_metrics"), met0);
  const keysAfter = (
    db.prepare(`SELECT DISTINCT group_key FROM company_groups`).all() as Array<{
      group_key: string;
    }>
  ).length;
  assert.ok(keysAfter <= keysBefore);
} finally {
  db.exec("ROLLBACK");
}

assert.equal(countTable(db, "company_groups"), cg0);
const still = db
  .prepare(`SELECT group_key FROM company_groups WHERE ticker = ?`)
  .all(ticker) as Array<{ group_key: string }>;
assert.equal(still.length, memberships.length);

const other = db
  .prepare(`SELECT group_key FROM company_groups WHERE ticker <> ? LIMIT 1`)
  .get(ticker) as { group_key: string };
db.exec("BEGIN");
try {
  const reassigned = applyMappingChange(
    {
      action: "reassign",
      ticker,
      group_key: removeKey,
      new_group_key: other.group_key,
      expected_group_name: memberships[0].group_name,
    },
    { confirm: true, db },
  );
  assert.equal(reassigned.ok, true);
  assert.equal(reassigned.reassigned, 1);
  assert.equal(reassigned.after?.company_pairs, 5013);
  const remaining = db
    .prepare(`SELECT group_key FROM company_groups WHERE ticker = ?`)
    .all(ticker) as Array<{ group_key: string }>;
  assert.ok(remaining.some((r) => r.group_key === keepKey));
  assert.ok(!remaining.some((r) => r.group_key === removeKey));
  assert.ok(remaining.some((r) => r.group_key === other.group_key));
  assert.equal(countTable(db, "board_seats"), seats0);
  assert.equal(countTable(db, "board_seat_events"), events0);
  const dups = db
    .prepare(
      `SELECT ticker, group_key, COUNT(*) n FROM company_groups
       GROUP BY ticker, group_key HAVING n > 1`,
    )
    .all();
  assert.equal(dups.length, 0);
} finally {
  db.exec("ROLLBACK");
}
db.close();

assert.equal(
  loadNewConnections({
    days: 180,
    maxTargetMcap: 5000,
    includeFormerSeats: false,
    pageSize: 1,
  }).total,
  115,
);
assert.equal(loadDirectorHubs({ minBoards: 3, pageSize: 1 }).total, 824);
assert.equal(loadCrossGroupNetwork({ pane: "groups", pageSize: 1 }).summary.relationships, 626);
assert.equal(loadNetworkClusters({ pageSize: 1 }).summary.clusters, 115);

console.log("group-mapping-review.test.ts ok");
