import assert from "node:assert/strict";
import {
  barsCoverWindow,
  capWeightIndex,
  downsampleSeries,
  equalWeightIndex,
  lastSessionReturnPct,
  rangeSeriesReturnPct,
  rebaseCloses,
  rotationFetchYears,
  rotationMaLookbackStart,
  rotationWindowStart,
  rotationYearsBack,
  seriesCoversStart,
  seriesReturnPct,
  sessionSpanReturnPct,
  stitchWarmup,
  tradingSessionsForRange,
  windowRebaseSeries,
  windowReturnPct,
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

// 1D = last two sessions only (not the whole calendar lookback).
const daily = [
  { date: "2026-11-21", value: 100 },
  { date: "2026-11-24", value: 110 },
  { date: "2026-11-25", value: 105 },
  { date: "2026-11-26", value: 126 }, // +20% vs prior session
];
assert.equal(tradingSessionsForRange("1D"), 1);
assert.equal(tradingSessionsForRange("1W"), 5);
assert.ok(Math.abs((lastSessionReturnPct(daily) ?? 0) - 20) < 1e-9);
assert.ok(Math.abs((rangeSeriesReturnPct(daily, "1D") ?? 0) - 20) < 1e-9);
const oneDStart = rotationWindowStart("2026-11-26", "1D");
assert.equal(oneDStart, "2026-11-21");
assert.ok(Math.abs((windowReturnPct(daily, oneDStart, "1D") ?? 0) - 20) < 1e-9);
// Without the 1D flag, same window is first→last (~+26%).
assert.ok(Math.abs((windowReturnPct(daily, oneDStart) ?? 0) - 26) < 1e-9);

// 1W = exactly 5 trading sessions (6 closes), not calendar first→last.
const week = [
  { date: "2026-11-12", value: 95 },
  { date: "2026-11-13", value: 96 },
  { date: "2026-11-14", value: 97 },
  { date: "2026-11-17", value: 100 },
  { date: "2026-11-18", value: 101 },
  { date: "2026-11-19", value: 102 },
  { date: "2026-11-20", value: 103 },
  { date: "2026-11-21", value: 104 },
  { date: "2026-11-24", value: 105 },
  { date: "2026-11-25", value: 106 },
  { date: "2026-11-26", value: 110 }, // 5 sessions back = Nov 19 (102)
];
assert.ok(Math.abs((sessionSpanReturnPct(week, 5) ?? 0) - ((110 / 102 - 1) * 100)) < 1e-9);
assert.ok(Math.abs((rangeSeriesReturnPct(week, "1W") ?? 0) - ((110 / 102 - 1) * 100)) < 1e-9);
const oneWStart = rotationWindowStart("2026-11-26", "1W");
assert.equal(oneWStart, "2026-11-12");
assert.ok(Math.abs((windowReturnPct(week, oneWStart, "1W") ?? 0) - ((110 / 102 - 1) * 100)) < 1e-9);
// Full-window (no 1W flag) is first→last from lookback (~+15.79%).
assert.ok(Math.abs((windowReturnPct(week, oneWStart) ?? 0) - ((110 / 95 - 1) * 100)) < 1e-9);
assert.equal(barsCoverWindow(
  week.map((p) => ({ date: p.date, close: p.value })),
  oneWStart,
  "1W",
), true);
assert.equal(barsCoverWindow(
  week.slice(-3).map((p) => ({ date: p.date, close: p.value })),
  oneWStart,
  "1W",
), false);

// Full window: a normal return.
assert.ok(Math.abs((windowReturnPct(long, "2026-02-01") ?? 0) - (125 / 75 - 1) * 100) < 1e-9);
// Window opened on a weekend/holiday: first close 4 days later still counts.
assert.equal(windowReturnPct(long, "2025-12-28"), 150);
// History starts after the window (recent listing): no return.
assert.equal(windowReturnPct(long, "2025-12-01"), null);
// A single close is not a 0% return.
assert.equal(windowReturnPct([{ date: "2026-11-23", value: 100 }], "2026-08-22"), null);
assert.equal(windowReturnPct([{ date: "2026-11-23", value: 100 }], "2026-11-23"), null);
assert.equal(windowReturnPct([], "2026-01-01"), null);

// Sector set: a recent listing is left out, a full-history stock counts.
const fullBars = [
  { date: "2026-01-01", close: 100 },
  { date: "2026-02-01", close: 110 },
  { date: "2026-03-01", close: 90 },
];
const lateBars = [
  { date: "2026-02-20", close: 10 },
  { date: "2026-03-01", close: 120 },
];
assert.equal(barsCoverWindow(fullBars, "2026-01-01"), true);
assert.equal(barsCoverWindow(lateBars, "2026-01-01"), false);
assert.equal(barsCoverWindow([{ date: "2026-03-01", close: 5 }], "2026-03-01"), false);

// Warm-up is scaled onto the window line; the window itself is unchanged.
const windowLine = [
  { date: "2026-03-01", value: 100 },
  { date: "2026-04-01", value: 120 },
];
const stitched = stitchWarmup(long, windowLine);
assert.equal(stitched.length, 4);
assert.equal(stitched[0]?.value, 50);
assert.equal(stitched[2]?.value, 100);
assert.equal(stitched[3]?.value, 120);
assert.deepEqual(stitchWarmup(long, []), []);

console.log("ok");
