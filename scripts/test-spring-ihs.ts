/**
 * Smoke test for spring + inverse H&S helpers.
 * Run: npx tsx scripts/test-spring-ihs.ts
 */
import assert from "node:assert/strict";
import type { Bar } from "../src/lib/indicators";
import { scanSpringIhsLong } from "../src/lib/spring-ihs";

function bar(
  date: string,
  o: number,
  h: number,
  l: number,
  c: number,
  v = 1_000_000,
): Bar {
  return { date, open: o, high: h, low: l, close: c, volume: v };
}

/** Short series: engine needs history — empty/short must not throw. */
assert.deepEqual(scanSpringIhsLong([]), []);
assert.deepEqual(
  scanSpringIhsLong([bar("2026-01-02", 10, 11, 9, 10)]),
  [],
);

console.log("spring-ihs ok");
