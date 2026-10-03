/**
 * Network cluster graph helpers (in-memory) plus live governance.db gold.
 */
import assert from "node:assert/strict";
import {
  clusterDensity,
  companyPairsFromSeats,
  connectedCompanyClusters,
  loadCrossGroupNetwork,
  loadDirectorHubs,
  loadNetworkClusterDetail,
  loadNetworkClusters,
  loadNewConnections,
  normalizeCompanyPair,
  pairGroupType,
} from "../src/lib/company-network";

assert.deepEqual(normalizeCompanyPair("BBB", "AAA"), {
  ticker_a: "AAA",
  ticker_b: "BBB",
});
assert.equal(normalizeCompanyPair("AAA", "AAA"), null);

const seats = [
  { person_id: "p1", ticker: "A" },
  { person_id: "p1", ticker: "B" },
  { person_id: "p1", ticker: "C" },
  { person_id: "p2", ticker: "B" },
  { person_id: "p2", ticker: "C" },
  { person_id: "p3", ticker: "D" },
  { person_id: "p3", ticker: "E" },
  { person_id: "p4", ticker: "F" },
];
const pairs = companyPairsFromSeats(seats);
assert.equal(pairs.some((p) => p.ticker_a === p.ticker_b), false);
assert.equal(
  new Set(pairs.map((p) => `${p.ticker_a}|${p.ticker_b}`)).size,
  pairs.length,
);
const abc = pairs.find((p) => p.ticker_a === "B" && p.ticker_b === "C");
assert.equal(abc?.shared_directors, 2);
assert.equal(
  pairs.filter((p) => ["A", "B", "C"].includes(p.ticker_a) && ["A", "B", "C"].includes(p.ticker_b))
    .length,
  3,
);

const clusters = connectedCompanyClusters(
  pairs,
  ["A", "B", "C", "D", "E", "F"],
).sort((a, b) => a.cluster.localeCompare(b.cluster));
const twoPlus = clusters.filter((c) => c.tickers.length >= 2);
assert.equal(twoPlus.length, 2);
assert.deepEqual(twoPlus[0].tickers, ["A", "B", "C"]);
assert.equal(twoPlus[0].cluster, "A");
assert.deepEqual(twoPlus[1].tickers, ["D", "E"]);
assert.equal(twoPlus[1].cluster, "D");
assert.equal(clusters.filter((c) => c.tickers.length === 1)[0].cluster, "F");

const again = connectedCompanyClusters(pairs, ["A", "B", "C", "D", "E", "F"]);
assert.deepEqual(
  again.map((c) => c.cluster).sort(),
  clusters.map((c) => c.cluster).sort(),
);

const trans = connectedCompanyClusters(
  [
    { ticker_a: "A", ticker_b: "B" },
    { ticker_a: "B", ticker_b: "C" },
  ],
  ["A", "B", "C"],
);
assert.equal(trans.length, 1);
assert.deepEqual(trans[0].tickers, ["A", "B", "C"]);

assert.equal(clusterDensity(2, 1), 100);
assert.equal(clusterDensity(3, 3), 100);
assert.equal(clusterDensity(3, 2), 66.7);
assert.equal(clusterDensity(1, 0), null);

function reachable(
  start: string,
  goal: string,
  adj: Map<string, string[]>,
): boolean {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const n = q.pop()!;
    if (n === goal) return true;
    for (const nxt of adj.get(n) || []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        q.push(nxt);
      }
    }
  }
  return false;
}
const adj = new Map<string, string[]>();
for (const p of pairs) {
  adj.set(p.ticker_a, [...(adj.get(p.ticker_a) || []), p.ticker_b]);
  adj.set(p.ticker_b, [...(adj.get(p.ticker_b) || []), p.ticker_a]);
}
for (const c of twoPlus) {
  for (const a of c.tickers) {
    for (const b of c.tickers) {
      assert.ok(reachable(a, b, adj));
    }
  }
}
for (const p of pairs) {
  const ca = twoPlus.find((c) => c.tickers.includes(p.ticker_a));
  const cb = twoPlus.find((c) => c.tickers.includes(p.ticker_b));
  assert.equal(ca?.cluster, cb?.cluster);
}

const live = loadNetworkClusters({ pageSize: 200, minCompanies: 2 });
assert.equal(live.summary.clusters, 115);
assert.equal(live.summary.companies, 1887);
assert.equal(live.total, 115);
assert.ok(live.rows.every((r) => r.companies >= 2));
assert.ok(live.rows[0].companies >= live.rows[live.rows.length - 1].companies);
assert.equal(live.rows[0].cluster, "20MICRONS");
assert.equal(live.rows[0].companies, 1594);

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
assert.equal(gap.summary.n_10k_connections, 31);

assert.equal(loadDirectorHubs({ minBoards: 3, pageSize: 1 }).total, 824);
assert.equal(loadDirectorHubs({ minBoards: 2, pageSize: 1 }).summary.directors, 2328);

const xg = loadCrossGroupNetwork({ pane: "groups", pageSize: 1 });
assert.equal(xg.summary.relationships, 626);
assert.equal(xg.summary.directors, 327);
assert.equal(xg.summary.companies, 375);
assert.equal(xg.summary.groups, 152);
assert.equal(xg.summary.group_pairs, 410);

const keys = new Map<string, Set<string>>([
  ["A", new Set(["g1"])],
  ["B", new Set(["g1"])],
  ["C", new Set(["g2"])],
  ["D", new Set(["g2"])],
  ["E", new Set()],
]);
assert.equal(pairGroupType("A", "B", keys), "same_group");
assert.equal(pairGroupType("A", "C", keys), "cross_group");
assert.equal(pairGroupType("A", "E", keys), "unclassified");
assert.equal(pairGroupType("E", "C", keys), "unclassified");

const groupedNoShare = companyPairsFromSeats([
  { person_id: "p1", ticker: "A" },
  { person_id: "p1", ticker: "B" },
  { person_id: "p2", ticker: "C" },
]);
assert.equal(
  groupedNoShare.some((p) => p.ticker_a === "A" && p.ticker_b === "C"),
  false,
);
const groupedClusters = connectedCompanyClusters(groupedNoShare, [
  "A",
  "B",
  "C",
]);
assert.equal(groupedClusters.filter((c) => c.tickers.length >= 2).length, 1);
assert.equal(
  groupedClusters.find((c) => c.tickers.includes("C"))?.tickers.length,
  1,
);

assert.equal(live.summary.governance_connections, 5013);
assert.ok(live.summary.isolated_companies > 0);
const classified =
  live.rows.reduce((n, r) => n + r.same_group_relationships, 0) +
  live.rows.reduce((n, r) => n + r.cross_group_relationships, 0) +
  live.rows.reduce((n, r) => n + r.unclassified_relationships, 0);
assert.equal(classified, 5013);

const missingMcapPairs = companyPairsFromSeats([
  { person_id: "px", ticker: "NOMCAP" },
  { person_id: "px", ticker: "HASCAP" },
]);
assert.equal(missingMcapPairs.length, 1);
assert.equal(missingMcapPairs[0].ticker_a, "HASCAP");

const detail = loadNetworkClusterDetail(live.rows[0].cluster);
assert.ok(detail.cluster);
assert.ok(detail.directors.every((d) => d.person_id.length > 0));
assert.ok(
  detail.connections.every(
    (c) => c.ticker_a !== c.ticker_b && c.shared_people.length === c.shared_directors,
  ),
);
assert.equal(
  detail.cluster.same_group_relationships +
    detail.cluster.cross_group_relationships +
    detail.cluster.unclassified_relationships,
  detail.cluster.direct_relationships,
);

console.log("network-clusters.test.ts ok");
