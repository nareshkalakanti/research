/**
 *   npm run test:din-fill
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseScreenshotBoard } from "../src/lib/din-screenshot-parse";
import { pickUniqueListing, scoreListingName } from "../src/lib/listing-name-match";
import { zaubaCorpSearchQuery } from "../src/lib/links";

const gold = JSON.parse(
  fs.readFileSync(path.join("test", "din-fill.gold.json"), "utf8"),
) as {
  text: string;
  company: string;
  seats: Array<{ din: string; name: string }>;
  zauba_table: string;
  zauba_html: string;
  cg_html: string;
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

const cg = parseScreenshotBoard(gold.cg_html);
assert.equal(cg.ticker, "EXWLTH");
assert.equal(cg.company?.toUpperCase().includes("WEALTH"), true);
assert.equal(cg.seats.length, 2);
assert.equal(cg.seats[0]?.din, "00163054");
assert.equal(cg.seats[0]?.name, "ALPHA PERSON");
assert.equal(cg.seats[1]?.din, "07789972");

const paren = parseScreenshotBoard(
  "Directors & Key Managerial Personnel of EXAMPLE SUPREME (INDIA)\nCurrent Directors & Key Managerial Personnel of EXAMPLE SUPREME (INDIA)\n03481378 ALPHA PERSON Director 2011-05-16",
);
assert.equal(paren.company, "EXAMPLE SUPREME (INDIA)");
assert.equal(paren.seats[0]?.din, "03481378");

const amp = parseScreenshotBoard(
  "Current Directors & Key Managerial Personnel of EXAMPLE TYRE & INDUSTRIES\nDIN Director Name Designation Appointment Date\n00026540 ALPHA PERSON Whole-time director 2010-01-20",
);
assert.equal(amp.company, "EXAMPLE TYRE & INDUSTRIES");
const h2 = parseScreenshotBoard(
  "<h2>Directors &amp; Key Managerial Personnel of EXAMPLE TYRE &amp; INDUSTRIES</h2><table class=\"table table-bordered\"><thead><tr><th>DIN</th><th>Director Name</th><th>Designation</th></tr></thead><tbody><tr><td>00026540</td><td>ALPHA PERSON</td><td>Whole-time director</td></tr></tbody></table>",
);
assert.equal(h2.company, "EXAMPLE TYRE & INDUSTRIES");
assert.equal(h2.seats[0]?.din, "00026540");

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
assert.ok(
  scoreListingName("example hottels", "EXHOT", "Example Hotels Limited") >= 70,
);
const dotted = [
  { ticker: "QUEUECO", name: "Queue Placeholder Ltd" },
  { ticker: "EXHOT", name: "Example Hotels Limited" },
  { ticker: "ABMACH", name: "AB Buildwel Machine Works Ltd" },
];
assert.equal(
  pickUniqueListing("A. B. BUILDWELL PROPERTIES", dotted)?.ticker,
  "ABMACH",
);
assert.ok(
  scoreListingName(
    "G. G. EXAMPLEKER PROPERTIES",
    "EXMACH",
    "GG Examplekar Machine Works Ltd",
  ) >= 70,
);
const tickerAsName = [
  { ticker: "QUEUECO", name: "Queue Placeholder Ltd" },
  { ticker: "ALPHACO", name: "ALPHACO" },
  { ticker: "ALPHRCO", name: "ALPHRCO CAPITAL SERVICES LIMITED" },
];
assert.equal(
  pickUniqueListing("ALPHACO SERVICES", tickerAsName)?.ticker,
  "ALPHACO",
);
assert.ok(scoreListingName("ALPHACO SERVICES", "ALPHRCO", "ALPHRCO CAPITAL SERVICES LIMITED") < 70);

console.log("test:din-fill: ok");
