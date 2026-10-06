import assert from "node:assert/strict";
import { crossedAbove200DmaFromCloses } from "../src/lib/dma200-cross";

/** Flat base, one close below, then above → moved above today. */
function seriesCrossToday(): number[] {
  const base = Array.from({ length: 200 }, () => 100);
  return [...base, 99, 105];
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
assert.equal(crossedAbove200DmaFromCloses(seriesAlreadyAbove()), false);
assert.equal(crossedAbove200DmaFromCloses(Array.from({ length: 50 }, () => 1)), false);

console.log("dma200-cross.test.ts ok");
