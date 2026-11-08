/**
 *   npx tsx test/pead-score-returns.test.ts
 */
import assert from "node:assert/strict";
import {
  computeDailyRetFf,
  computeReturnsPct,
  peadRecommendation,
  resultEntryClose,
  returnsPctFromEntry,
} from "../src/lib/pead-score";

const bars = [
  { date: "2025-10-08", close: 100 },
  { date: "2025-10-09", close: 102 }, // result day
  { date: "2025-10-10", close: 110 }, // first after
  { date: "2025-10-13", close: 121 },
];

const rd = "2025-10-09";

// Ret = Drift-style: result-day close → LTP / last.
assert.equal(resultEntryClose(bars, rd), 102);
assert.equal(computeReturnsPct(bars, rd, 121), 18.63); // 121/102 - 1
assert.equal(computeReturnsPct(bars, rd, null), 18.63);

// Day = prior → result session only (not later max move).
assert.equal(computeDailyRetFf(bars, rd), 2); // 102/100 - 1

// Result bar only + live LTP still yields Ret.
assert.equal(
  computeReturnsPct(
    [
      { date: "2025-10-08", close: 100 },
      { date: "2025-10-09", close: 102 },
    ],
    rd,
    105,
  ),
  2.94, // 105/102 - 1
);
assert.equal(
  computeDailyRetFf(
    [
      { date: "2025-10-08", close: 100 },
      { date: "2025-10-09", close: 102 },
    ],
    rd,
  ),
  2,
);

assert.equal(returnsPctFromEntry(102, 121), 18.63);
assert.equal(peadRecommendation(45), "Buy");
assert.equal(peadRecommendation(20), "Watch");
assert.equal(peadRecommendation(10), "Avoid");
assert.equal(peadRecommendation(-1), "Avoid");
assert.equal(peadRecommendation(null), null);

console.log("pead-score-returns: ok");
