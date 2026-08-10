/**
 * Forward PE unit tests (no network).
 * Run: npx tsx scripts/test-forward-pe.ts
 */
import assert from "node:assert/strict";
import {
  computeForwardPe,
  forwardPeBand,
} from "../src/lib/forward-pe-band";

assert.equal(computeForwardPe(100, 5), 5); // 100 / 20
assert.equal(computeForwardPe(200, 2.5), 20);
assert.equal(computeForwardPe(100, -1), 999);
assert.equal(computeForwardPe(null, 5), null);

assert.equal(forwardPeBand(15), "good");
assert.equal(forwardPeBand(20), "good");
assert.equal(forwardPeBand(25), "mid");
assert.equal(forwardPeBand(41), "bad");
assert.equal(forwardPeBand(999), "bad");
assert.equal(forwardPeBand(null), "none");

console.log("test-forward-pe: all passed");
