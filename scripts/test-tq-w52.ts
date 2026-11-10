/**
 * TQ : W52 zone helpers — green-from-below must match TradingView coloring.
 * Run: npx tsx scripts/test-tq-w52.ts
 */
import assert from "node:assert/strict";
import {
  classifyTqW52Zone,
  isTqW52GreenFromBelow,
} from "../src/lib/signals";

assert.equal(classifyTqW52Zone(0.23, -0.05), "green");
assert.equal(classifyTqW52Zone(-0.05, -0.1), "yellow");
assert.equal(classifyTqW52Zone(-0.1, -0.05), "red");
assert.equal(classifyTqW52Zone(null, -0.05), null);

assert.equal(isTqW52GreenFromBelow(0.18, -0.057), true);
assert.equal(isTqW52GreenFromBelow(0.18, 0.05), false);
assert.equal(isTqW52GreenFromBelow(-0.05, -0.1), false);
assert.equal(isTqW52GreenFromBelow(0, -0.01), true);
assert.equal(isTqW52GreenFromBelow(null, -0.01), false);

console.log("✓ TQ W52 green-from-below helpers");
