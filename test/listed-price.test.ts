/**
 *   npx tsx test/listed-price.test.ts
 */
import assert from "node:assert/strict";
import {
  listedPriceFor,
  pickFreshestListedPrice,
  type ListedPriceObs,
} from "../src/lib/listed-price";

const older: ListedPriceObs = {
  price: 199.15,
  fetched_at: "2026-10-15T16:46:26.867Z",
  source: "stock_metrics",
};
const newer: ListedPriceObs = {
  price: 143,
  fetched_at: "2026-11-22T21:30:42.303Z",
  source: "screener_ratios",
};

assert.equal(pickFreshestListedPrice(older, newer)?.price, 143);
assert.equal(pickFreshestListedPrice(newer, older)?.price, 143);
assert.equal(pickFreshestListedPrice(older, null)?.price, 199.15);
assert.equal(pickFreshestListedPrice(null, newer)?.price, 143);

// Equal timestamps → prefer stock_metrics.
const tieA: ListedPriceObs = { ...older, fetched_at: "2026-11-22T00:00:00.000Z" };
const tieB: ListedPriceObs = { ...newer, fetched_at: "2026-11-22T00:00:00.000Z" };
assert.equal(pickFreshestListedPrice(tieA, tieB)?.source, "stock_metrics");
assert.equal(pickFreshestListedPrice(tieB, tieA)?.source, "stock_metrics");

// Reject non-positive.
assert.equal(
  pickFreshestListedPrice({ ...newer, price: 0 }, older)?.price,
  199.15,
);

// Smoke: map loads without throw; any hit is a positive price.
const sample = listedPriceFor("TCS") ?? listedPriceFor("RELIANCE");
if (sample) assert.ok(sample.price > 0 && sample.fetched_at);

console.log("listed-price.test.ts: ok");
