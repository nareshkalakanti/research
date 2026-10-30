import assert from "node:assert/strict";
import {
  capWeightIndex,
  downsampleSeries,
  equalWeightIndex,
  rebaseCloses,
  rotationFetchYears,
  rotationMaLookbackStart,
  rotationYearsBack,
  seriesCoversStart,
  seriesReturnPct,
  windowRebaseSeries,
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

const cap = capWeightIndex(
  [
    { bars: a, mcap: 1 },
    { bars: [
      { date: "2026-01-01", close: 20 },
      { date: "2026-01-02", close: 20 },
      { date: "2026-01-03", close: 30 },
    ], mcap: 3 },
  ],
  "2026-01-01",
);
assert.equal(cap[0]?.value, 100);
assert.ok(Math.abs((cap[2]?.value ?? 0) - 142.5) < 1e-9);

const look = rotationMaLookbackStart("2026-06-01");
assert.ok(look < "2026-06-01");
assert.ok(look <= "2025-08-01");

// Sparse member must not dominate on gap days (forward-fill).
const dense = [
  { date: "2026-01-01", close: 100 },
  { date: "2026-01-02", close: 100 },
  { date: "2026-01-03", close: 100 },
  { date: "2026-01-04", close: 100 },
];
const sparse = [
  { date: "2026-01-01", close: 50 },
  { date: "2026-01-03", close: 100 }, // +100% vs start; missing 01-02 and 01-04
];
const sparseEq = equalWeightIndex([dense, sparse], "2026-01-01");
const byDate = new Map(sparseEq.map((p) => [p.date, p.value]));
// On 01-03 both live: (100 + 200) / 2 = 150
assert.ok(Math.abs((byDate.get("2026-01-03") ?? 0) - 150) < 1e-9);
// On 01-04 only dense prints; sparse carries 200 → (100 + 200) / 2 = 150 (not 100)
assert.ok(Math.abs((byDate.get("2026-01-04") ?? 0) - 150) < 1e-9);

const long = [
  { date: "2026-01-01", value: 50 },
  { date: "2026-02-01", value: 75 },
  { date: "2026-03-01", value: 100 },
  { date: "2026-04-01", value: 125 },
];
assert.equal(seriesCoversStart(long, "2026-02-01"), true);
assert.equal(seriesCoversStart(long, "2025-12-01"), false);
const win = windowRebaseSeries(long, "2026-02-01");
assert.equal(win[0]?.date, "2026-02-01");
assert.ok(Math.abs((win[0]?.value ?? 0) - 100) < 1e-9);
assert.ok(Math.abs((win[win.length - 1]?.value ?? 0) - (125 / 75) * 100) < 1e-9);
assert.equal(downsampleSeries(long, 2).length, 2);
assert.ok(rotationFetchYears() >= rotationYearsBack("5Y"));
assert.equal(rotationFetchYears(), rotationYearsBack("5Y"));

console.log("ok");
