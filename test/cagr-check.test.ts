import assert from "node:assert/strict";
import { cagrCheck } from "../src/lib/napkin/quality-flags";

const years = (from: number, n: number) => Array.from({ length: n }, (_, i) => `${from + i}-03-31`);

// SEPC sales 2016–2026: 10-yr window, start 548 → 1054 = 6.8%, fail (no shortening).
const sepc = [548, 744, 829, 1202, 1208, 583, 329, 379, 561, 598, 1054];
let c = cagrCheck("sales", "Sales growth", years(2016, 11), sepc);
assert.equal(c.value, "6.8%");
assert.equal(c.verdict, "fail");
assert.match(c.note!, /^10 yrs · 2016 → 2026$/);

// Only 2019–2026 (8 yrs): 5-yr window starts 2021 = 583, below 60% of the 1208 peak? No (583/1208 = 48%) → recovery, not scored.
c = cagrCheck("sales", "Sales growth", years(2019, 8), sepc.slice(3));
assert.equal(c.verdict, "na");
assert.match(c.note!, /Recovery from a low base/);

// Gaps: the start point must be the exact year; the label shows real years.
const gapDates = ["2016-03-31", "2019-03-31", "2021-03-31", "2023-03-31", "2026-03-31"];
c = cagrCheck("bv", "Book value", gapDates, [10, 11, 12, 13, 20]);
assert.match(c.note!, /^10 yrs · 2016 → 2026$/);
assert.equal(c.value, `${((Math.pow(2, 1 / 10) - 1) * 100).toFixed(1)}%`);

// Dilution: share capital doubled in the window → not comparable.
c = cagrCheck("bv", "Book value", years(2023, 4), [1087, 1210, 1506, 1919], {
  shareCapital: { dates: years(2023, 4), values: [1322, 1410, 1564, 1943] },
});
assert.equal(c.verdict, "na");
assert.match(c.note!, /Not comparable: share capital \+47%/);

// Healthy grower still passes.
c = cagrCheck("sales", "Sales growth", years(2016, 11), [100, 112, 125, 140, 157, 176, 197, 221, 247, 277, 310]);
assert.equal(c.verdict, "pass");
console.log("ok");
