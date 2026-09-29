/**
 *   npm run test:din-fill
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseScreenshotBoard } from "../src/lib/din-screenshot-parse";
import { pickUniqueListing } from "../src/lib/listing-name-match";
import { zaubaCorpSearchQuery } from "../src/lib/links";

const gold = JSON.parse(
  fs.readFileSync(path.join("test", "din-fill.gold.json"), "utf8"),
) as {
  text: string;
  company: string;
  seats: Array<{ din: string; name: string }>;
  zauba_table: string;
  zauba_html: string;
};

const got = parseScreenshotBoard(gold.text);
assert.equal(got.company, gold.company);
assert.equal(got.seats.length, gold.seats.length);
assert.equal(got.seats[0]?.din, gold.seats[0]?.din);
assert.equal(got.seats[0]?.name, gold.seats[0]?.name);
assert.equal(got.seats[1]?.din, gold.seats[1]?.din);

const table = parseScreenshotBoard(gold.zauba_table);
assert.equal(table.seats.length, 4);
assert.equal(table.seats[0]?.din, "00056364");
assert.equal(table.seats[2]?.designation.toLowerCase().includes("additional"), true);

const html = parseScreenshotBoard(gold.zauba_html);
assert.equal(html.seats.length, 4);
assert.equal(html.seats[0]?.name, "ALPHA PERSON");
assert.equal(html.seats[2]?.din, "02647994");

assert.equal(zaubaCorpSearchQuery("Example Movers Ltd"), "Example Movers Ltd zauba corp");

const listings = [
  { ticker: "QUEUECO", name: "Queue Placeholder Ltd" },
  { ticker: "EXHOT", name: "Example Hotels Limited" },
  { ticker: "EXBLD", name: "Example Buildwell Ltd" },
];
assert.equal(
  pickUniqueListing("EXAMPLE HOTELS", listings, "QUEUECO")?.ticker,
  "EXHOT",
);
assert.equal(
  pickUniqueListing("Example Buildwell", listings, "QUEUECO")?.ticker,
  "EXBLD",
);
assert.equal(pickUniqueListing("Example", listings, "QUEUECO"), null);

console.log("test:din-fill: ok");
