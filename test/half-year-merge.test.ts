/**
 *   npx tsx test/half-year-merge.test.ts
 */
import assert from "node:assert/strict";
import { halfYearRhythm, mergeQuarterFill, type QuarterPoint } from "../src/lib/quarter-panel";

const pt = (date: string, revenue: number): QuarterPoint => ({ date, revenue, ebit: null, netIncome: null, eps: null, otherIncome: null });

// INDOSMC: half-yearly (Mar / Sep); another source adds a Dec quarter inside the Mar-26 half.
const halves = [pt("2025-03-31", 69), pt("2025-09-30", 113), pt("2026-03-31", 197), pt("2026-09-30", 216)];
assert.ok(halfYearRhythm(halves));
const merged = mergeQuarterFill(halves, [pt("2025-12-31", 102), pt("2026-09-30", 216)]);
assert.deepEqual(merged.map((q) => q.date), ["2025-03-31", "2025-09-30", "2026-03-31", "2026-09-30"]);

// Moved to quarterly after its last half: the newer quarters are kept.
const older = [pt("2024-03-31", 50), pt("2024-09-30", 60), pt("2025-03-31", 69)];
const moved = mergeQuarterFill(older, [pt("2025-06-30", 40), pt("2025-09-30", 45)]);
assert.deepEqual(moved.slice(-2).map((q) => q.date), ["2025-06-30", "2025-09-30"]);

// A quarterly series is merged as before (no filtering).
const qs = [pt("2025-12-31", 1), pt("2026-03-31", 1), pt("2026-06-30", 1)];
assert.equal(halfYearRhythm(qs), null);
assert.equal(mergeQuarterFill(qs, [pt("2026-09-30", 1)]).length, 4);

console.log("half-year merge ok");
