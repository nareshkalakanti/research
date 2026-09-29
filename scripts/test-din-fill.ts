/**
 *   npm run test:din-fill
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseScreenshotBoard } from "../src/lib/din-screenshot-parse";
import { zaubaCorpSearchQuery } from "../src/lib/links";

const gold = JSON.parse(
  fs.readFileSync(path.join("test", "din-fill.gold.json"), "utf8"),
) as {
  text: string;
  company: string;
  seats: Array<{ din: string; name: string }>;
};

const got = parseScreenshotBoard(gold.text);
assert.equal(got.company, gold.company);
assert.equal(got.seats.length, gold.seats.length);
assert.equal(got.seats[0]?.din, gold.seats[0]?.din);
assert.equal(got.seats[0]?.name, gold.seats[0]?.name);
assert.equal(got.seats[1]?.din, gold.seats[1]?.din);

assert.equal(zaubaCorpSearchQuery("Example Movers Ltd"), "Example Movers Ltd zauba corp");

console.log("test:din-fill: ok");
