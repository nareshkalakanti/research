/**
 *   npx tsx test/screener-backoff.test.ts
 */
import assert from "node:assert/strict";
import { screenerBackoffMs, screenerBlocked } from "../src/lib/screener-fetch";

const MIN = 60 * 1000;

assert.equal(screenerBackoffMs(1), 15 * MIN);
assert.equal(screenerBackoffMs(2), 30 * MIN);
assert.equal(screenerBackoffMs(3), 60 * MIN);
assert.equal(screenerBackoffMs(5), 4 * 60 * MIN);
assert.equal(screenerBackoffMs(6), 6 * 60 * MIN, "capped at 6h");
assert.equal(screenerBackoffMs(20), 6 * 60 * MIN);
assert.equal(screenerBackoffMs(0), 15 * MIN);

assert.equal(screenerBlocked("", 429), true);
assert.equal(screenerBlocked("", 403), true);
assert.equal(screenerBlocked("<html>Too Many Requests</html>", 200), true);
assert.equal(screenerBlocked("<html>Profit & Loss</html>", 200), false);
assert.equal(screenerBlocked("not found", 404), false);

console.log("screener-backoff: ok");
