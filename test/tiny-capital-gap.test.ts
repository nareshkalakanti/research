/**
 * Tiny Capital Gap is a filter of canonical New Connections / Capital Gap.
 * Gold numbers live here; production code stays generic.
 */
import assert from "node:assert/strict";
import {
  loadNetworkClusters,
  loadNewConnections,
  loadTinyCapitalGap,
  loadTinyCapitalGapDetail,
  tinyCapitalGapBand,
} from "../src/lib/company-network";

assert.equal(tinyCapitalGapBand(99.9), "lt100");
assert.equal(tinyCapitalGapBand(100), "100_250");
assert.equal(tinyCapitalGapBand(249.9), "100_250");
assert.equal(tinyCapitalGapBand(250), "250_500");
assert.equal(tinyCapitalGapBand(499.9), "250_500");
assert.equal(tinyCapitalGapBand(500), "500_1000");
assert.equal(tinyCapitalGapBand(999.9), "500_1000");
assert.equal(tinyCapitalGapBand(1000), null);
assert.equal(tinyCapitalGapBand(0), null);

const canonical = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: false,
  pageSize: 200,
});
assert.equal(canonical.total, 115);
assert.equal(canonical.summary.unique_targets, 65);
assert.equal(canonical.summary.unique_directors, 70);
assert.equal(canonical.summary.cross_group, 8);
assert.ok(canonical.rows.every((e) => e.connected_current === 1));

const gap = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: false,
  aggregate: "gap",
  pageSize: 200,
});
assert.equal(gap.total, 65);
assert.equal(gap.summary.edges, 115);
assert.equal(gap.summary.n_10k_connections, 31);
assert.equal(gap.summary.n_25k_connections, 12);
assert.equal(gap.summary.mega_connections, 5);

const tiny = loadTinyCapitalGap({ days: 180, pageSize: 200 });
assert.equal(tiny.summary.canonical_edges, 115);
assert.equal(tiny.summary.canonical_targets, 65);
assert.equal(tiny.summary.companies, 46);
assert.equal(tiny.total, 46);
assert.equal(tiny.summary.band_lt100, 17);
assert.equal(tiny.summary.band_100_250, 7);
assert.equal(tiny.summary.band_250_500, 12);
assert.equal(tiny.summary.band_500_1000, 10);
assert.equal(
  tiny.summary.band_lt100 +
    tiny.summary.band_100_250 +
    tiny.summary.band_250_500 +
    tiny.summary.band_500_1000,
  46,
);
assert.ok(
  tiny.rows.every(
    (r) =>
      (r.target_market_cap ?? 0) > 0 && (r.target_market_cap ?? 0) < 1000,
  ),
);
assert.equal(tiny.summary.connected_10k, 9);
assert.equal(tiny.summary.max_gap_50x, 8);
assert.equal(tiny.summary.cross_group, 2);

const canonicalKeys = new Set(
  canonical.rows.map(
    (e) => `${e.target_ticker}|${e.person_id}|${e.connected_ticker}`,
  ),
);
assert.equal(canonicalKeys.size, canonical.rows.length);
for (const e of tiny.edges) {
  assert.ok(
    canonicalKeys.has(
      `${e.target_ticker}|${e.person_id}|${e.connected_ticker}`,
    ),
  );
  assert.equal(e.connected_current, 1);
}
const tinyKeys = tiny.edges.map(
  (e) => `${e.target_ticker}|${e.person_id}|${e.connected_ticker}`,
);
assert.equal(new Set(tinyKeys).size, tinyKeys.length);

const tickers = new Set(tiny.rows.map((r) => r.target_ticker));
assert.ok(tickers.has("APOLSINHOT"));
assert.ok(tickers.has("SONUINFRA"));
assert.ok(tickers.has("TATAYODOGA"));
assert.ok(tickers.has("INFOLLION"));
assert.ok(tickers.has("BIRLAMONEY"));
assert.ok(tickers.has("TVSELECT"));
assert.ok(tickers.has("KLL"));

const apol = tiny.rows.find((r) => r.target_ticker === "APOLSINHOT");
assert.ok(apol);
assert.equal(apol.connected_company_count, 4);
assert.equal(apol.connected_10000cr_count, 2);
assert.equal(apol.max_market_cap_ratio, 947.5);
assert.equal(apol.largest_connected_ticker, "NESTLEIND");

const sonu = tiny.rows.find((r) => r.target_ticker === "SONUINFRA");
assert.ok(sonu);
assert.equal(sonu.max_market_cap_ratio, 306.8);

const tvs = tiny.rows.find((r) => r.target_ticker === "TVSELECT");
assert.ok(tvs);
assert.ok(tvs.cross_group_count >= 1);
assert.equal(tvs.connected_10000cr_count, 2);

assert.equal(tiny.rows[0].target_market_cap! <= tiny.rows[tiny.rows.length - 1].target_market_cap!, true);

const xgOnly = loadTinyCapitalGap({ days: 180, pageSize: 200, cross: "yes" });
assert.equal(xgOnly.total, 2);

const below100 = loadTinyCapitalGap({
  days: 180,
  pageSize: 200,
  band: "lt100",
});
assert.equal(below100.total, 17);

const former = loadNewConnections({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: true,
  pageSize: 1,
});
assert.notEqual(former.total, 115);

const detail = loadTinyCapitalGapDetail("APOLSINHOT", { days: 180 });
assert.ok(detail.company);
assert.equal(detail.connections.length >= 1, true);
assert.ok(detail.directors.every((d) => d.person_id.length > 0));

const clusters = loadNetworkClusters({ pageSize: 1, minCompanies: 2 });
assert.equal(clusters.summary.governance_connections, 5013);
assert.equal(clusters.summary.clusters, 115);
assert.equal(clusters.summary.companies, 1887);
assert.equal(clusters.summary.isolated_companies, 1106);

console.log("tiny-capital-gap.test.ts ok");
