/**
 * Holdings Capital Gap: every personal holding with Cap Gap columns from
 * current board seats (not latest-join new_edges).
 */
import assert from "node:assert/strict";
import {
  loadHoldingsCapitalGap,
  loadHoldingsCapitalGapDetail,
} from "../src/lib/company-network";
import { loadHoldings } from "../src/lib/holdings";

const holdings = loadHoldings();
assert.ok(holdings.length > 0, "expected personal holdings in holdings.db");

const gap = loadHoldingsCapitalGap({ pageSize: 200, sort: "ratio" });
assert.equal(gap.holdings_count, holdings.length);
assert.equal(gap.total, holdings.length);
assert.equal(gap.targets.length, holdings.length);
assert.equal(gap.summary.unique_targets, holdings.length);

const byTicker = new Set(gap.targets.map((r) => r.target_ticker));
for (const h of holdings) {
  assert.ok(
    byTicker.has(h.ticker.toUpperCase()),
    `missing holding ${h.ticker}`,
  );
}

for (const row of gap.targets) {
  assert.ok(Number.isFinite(row.connected_companies));
  assert.ok(Number.isFinite(row.n_10k));
  assert.ok(Number.isFinite(row.n_25k));
  assert.ok(Number.isFinite(row.n_50k));
  assert.ok(Number.isFinite(row.cross_group_count));
  assert.ok(Number.isFinite(row.multi_board_director_count));
  if (row.connected_companies > 0) {
    assert.ok((row.largest_connected_mcap ?? 0) > 0);
    assert.ok((row.largest_ratio ?? 0) > 0);
    assert.ok(row.largest_connected_ticker);
  }
}

const withConn = gap.targets.filter((r) => r.connected_companies > 0);
assert.ok(withConn.length > 0, "expected some holdings with board connections");

const top = [...gap.targets].sort(
  (a, b) => (b.largest_ratio ?? 0) - (a.largest_ratio ?? 0),
)[0];
assert.ok(top.target_ticker);
const detail = loadHoldingsCapitalGapDetail(top.target_ticker, {
  sort: "ratio",
});
assert.ok(detail.rows.length >= 1);
assert.ok(
  detail.rows.every((e) => e.target_ticker === top.target_ticker),
);
assert.ok(
  detail.rows.every((e) => (e.connected_market_cap ?? 0) > 0),
);

const filtered = loadHoldingsCapitalGap({
  minRatio: 10,
  pageSize: 200,
});
assert.ok(filtered.total <= gap.total);
assert.ok(
  filtered.targets.every((r) => (r.largest_ratio ?? 0) >= 10),
);

console.log(
  `holdings-capital-gap.test.ts ok · ${gap.total} holdings · ${withConn.length} with connections · top ratio ${top.largest_ratio}x`,
);
