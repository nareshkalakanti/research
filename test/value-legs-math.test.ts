import assert from "node:assert/strict";
import { roce3yFromAnnual, sales3yFromAnnual } from "../src/lib/value-legs-math";

// Calendar 3Y when endpoints positive.
assert.equal(
  Math.round(sales3yFromAnnual([100, 110, 120, 133])! * 100) / 100,
  Math.round(((133 / 100) ** (1 / 3) - 1) * 10000) / 100,
);

// Young listing: 3 FY columns → 2Y CAGR allowed.
assert.ok(sales3yFromAnnual([100, 120, 144]) != null);

// Zero early years: need 4 positive FY for a true 3Y (3 positives → null).
assert.equal(sales3yFromAnnual([0, 0, 10, 20, 40]), null);
assert.ok(sales3yFromAnnual([0, 5, 10, 20, 40]) != null);

// Only two positive years → null.
assert.equal(sales3yFromAnnual([0, 0, 0, 688, 1312]), null);

// Tiny base (< ₹1 Cr) → rejected.
assert.equal(sales3yFromAnnual([0.5, 1, 2, 4]), null);

// Tiny base → absurd multiple rejected.
assert.equal(sales3yFromAnnual([0, 0, 0, 0.01, 0.83]), null);

// Single positive year → null.
assert.equal(sales3yFromAnnual([0, 0, 0, 0, 607]), null);

// ROCE: one year is enough.
assert.equal(roce3yFromAnnual([null, null, null, null, 12.5]), 12.5);
assert.equal(roce3yFromAnnual([10, 20, 30]), 20);

console.log("value-legs-math: ok");
