/**
 * TQ : W52 line colour — must match TradingView (green = full entry set,
 * red = RS < 0 and falling, yellow otherwise).
 * Run: npx tsx scripts/test-tq-w52.ts
 */
import assert from "node:assert/strict";
import { classifyTqW52Zone } from "../src/lib/signals";

// Green only when every entry condition holds — RS above 0 alone is yellow.
assert.equal(classifyTqW52Zone(0.54, 0.12, true), "green");
assert.equal(classifyTqW52Zone(0.9, 1.2), "yellow"); // 2024 decline above 0
assert.equal(classifyTqW52Zone(-0.35, -0.4), "yellow"); // below 0 but rising
assert.equal(classifyTqW52Zone(-0.45, -0.4), "red"); // below 0 and falling
assert.equal(classifyTqW52Zone(null, -0.05), null);

console.log("✓ TQ W52 colour helpers");
