/**
 * Pure tests for Scan · Basket factors.
 *   npx tsx scripts/test-quant-basket.ts
 */
import assert from "node:assert/strict";
import {
  combineWeighted,
  earningsYield,
  opmStd,
  patCv,
  pickSectorCappedBook,
  stdev,
  winsorize,
  zScores,
} from "../src/lib/quant-basket-factors";

assert.equal(stdev([1, 2, 3]) != null, true);
assert.ok(Math.abs((stdev([2, 2, 2]) ?? 1)) < 1e-9);
assert.equal(opmStd([0.1, 0.12, 0.11, 0.09]) != null, true);
assert.equal(patCv([10, 10, 10]), 0);
assert.equal(patCv([1, -1]), null);
assert.equal(earningsYield(-10, 1000), null);
assert.equal(earningsYield(50, 1000), 0.05);

const w = winsorize([1, 2, 3, 4, 100]);
assert.ok(w[w.length - 1]! < 100 || w.length < 5);

const z = zScores([1, 2, 3, null, 4]);
assert.equal(z[3], null);
assert.ok(z[0] != null && z[0]! < 0);

assert.ok(combineWeighted([{ z: 1, weight: 1 }]) === 1);
assert.equal(combineWeighted([{ z: null, weight: 1 }]), null);

const book = pickSectorCappedBook(
  [
    { sector: "A", score: 5 },
    { sector: "A", score: 4 },
    { sector: "A", score: 3 },
    { sector: "B", score: 4.5 },
    { sector: "B", score: 3.5 },
    { sector: "C", score: 2 },
  ],
  5,
  0.4,
);
assert.equal(book.length, 5);
assert.equal(book.filter((r) => r.sector === "A").length, 2);

console.log("test-quant-basket: ok");
