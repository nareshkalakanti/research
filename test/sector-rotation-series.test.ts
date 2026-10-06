import assert from "node:assert/strict";
import {
  equalWeightIndex,
  rebaseCloses,
  seriesReturnPct,
} from "../src/lib/sector-rotation-series";

const a = [
  { date: "2026-01-01", close: 10 },
  { date: "2026-01-02", close: 11 },
  { date: "2026-01-03", close: 12 },
];
const b = [
  { date: "2026-01-01", close: 20 },
  { date: "2026-01-02", close: 20 },
  { date: "2026-01-03", close: 24 },
];
const rb = rebaseCloses(a, "2026-01-01");
assert.equal(rb[0]?.value, 100);
assert.ok(Math.abs((rb[2]?.value ?? 0) - 120) < 1e-9);

const eq = equalWeightIndex([a, b], "2026-01-01");
assert.equal(eq.length, 3);
assert.ok(Math.abs((eq[0]?.value ?? 0) - 100) < 1e-9);
assert.ok(Math.abs((eq[2]?.value ?? 0) - 120) < 1e-9);
assert.ok(Math.abs((seriesReturnPct(eq) ?? 0) - 20) < 1e-9);
console.log("ok");
