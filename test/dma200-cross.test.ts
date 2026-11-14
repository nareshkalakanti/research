import assert from "node:assert/strict";
import { crossedAbove200DmaFromCloses } from "../src/lib/dma200-cross";

/** Flat base, a week below, then a clear close above → fresh breakout. */
function seriesCrossToday(): number[] {
  const base = Array.from({ length: 200 }, () => 100);
  return [...base, 99, 99, 99, 99, 99, 105];
}

/** Chop around the line: above two days ago, one dip, back above → no signal. */
function seriesWhipsaw(): number[] {
  const base = Array.from({ length: 200 }, () => 100);
  return [...base, 99, 99, 101.5, 101.2, 99, 101.5];
}

/** A week below but today only 0.1% above the DMA → too thin to count. */
function seriesThinCross(): number[] {
  const base = Array.from({ length: 200 }, () => 100);
  return [...base, 99, 99, 99, 99, 99, 99.95];
}

/** Still below → not a cross. */
function seriesStillBelow(): number[] {
  const base = Array.from({ length: 200 }, () => 100);
  return [...base, 99, 98];
}

/** Already above, stays above → not a fresh cross. */
function seriesAlreadyAbove(): number[] {
  const above = Array.from({ length: 202 }, () => 110);
  return above;
}

assert.equal(crossedAbove200DmaFromCloses(seriesCrossToday()), true);
assert.equal(crossedAbove200DmaFromCloses(seriesStillBelow()), false);
assert.equal(crossedAbove200DmaFromCloses(seriesWhipsaw()), false);
assert.equal(crossedAbove200DmaFromCloses(seriesThinCross()), false);
// Old loose rule still available explicitly.
assert.equal(
  crossedAbove200DmaFromCloses([...Array.from({ length: 200 }, () => 100), 99, 105], {
    minDaysBelow: 1,
    minClearPct: 0,
  }),
  true,
);
assert.equal(crossedAbove200DmaFromCloses(seriesAlreadyAbove()), false);
assert.equal(crossedAbove200DmaFromCloses(Array.from({ length: 50 }, () => 1)), false);

console.log("dma200-cross.test.ts ok");
