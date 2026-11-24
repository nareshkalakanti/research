import assert from "node:assert/strict";
import {
  computeForwardPe,
  computeTrailingPe,
  epsPeriodsPerYear,
  forwardPeFromPanel,
  peRowsFromPanel,
} from "../src/lib/valuation";

// Period detection.
assert.equal(epsPeriodsPerYear(["Sep 2024", "Mar 2025", "Sep 2025", "Mar 2026", "Sep 2026"]), 2);
assert.equal(epsPeriodsPerYear(["Jun 2025", "Sep 2025", "Dec 2025", "Mar 2026", "Jun 2026"]), 4);
assert.equal(epsPeriodsPerYear(["Mar 2026", "Sep 2026"]), 2);
// Quarterly filer with too few columns stays quarterly.
assert.equal(epsPeriodsPerYear(["Mar 2026", "Jun 2026"]), 4);
assert.equal(epsPeriodsPerYear([]), 4);

// SHREEKARNI (half-yearly): price 518, EPS 6.89, 14.48, 8.54, 12.55, 5.97.
const sk = {
  labels: ["Sep 2024", "Mar 2025", "Sep 2025", "Mar 2026", "Sep 2026"],
  rows: [{ label: "EPS in Rs", values: [6.89, 14.48, 8.54, 12.55, 5.97] }],
};
// Forward: 518 / (5.97 × 2) = 43.4 (was 21.7 with × 4).
assert.equal(forwardPeFromPanel(518, sk as never), 43.4);
// Trailing: 518 / (12.55 + 5.97) = 28.0 (was 518 / 4 half-years = 12.5).
assert.equal(computeTrailingPe(518, [8.54, 12.55, 5.97], 2), 28);
const rows = peRowsFromPanel(sk as never, 518);
assert.equal(rows[0]!.values.at(-1), 27.97);
assert.equal(rows[1]!.values.at(-1), 43.4);

// Quarterly unchanged: × 4.
assert.equal(computeForwardPe(100, [1, 1, 1, 2.5]), 10);
// Loss in the latest half-year → trailing year when positive.
assert.equal(computeForwardPe(100, [3, -1], 2), 50);

console.log("ok");
