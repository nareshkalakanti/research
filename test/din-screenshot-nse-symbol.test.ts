import assert from "node:assert/strict";
import { parseScreenshotBoard } from "../src/lib/din-screenshot-parse";
import {
  conflictingProductTokens,
  scoreListingName,
} from "../src/lib/listing-name-match";

const ocr = `
For Example Industries Ltd (NSE symbol: EXIND LTD), the current directors' DINs are:

Director	Role	DIN
Alice Example	Chairperson & Managing Director, Promoter	02467557
Bob Example	Whole-Time Director, Promoter	02467366
`;

const parsed = parseScreenshotBoard(
  ocr.replace("EXIND LTD", "EXINDLTD"),
);
assert.match(parsed.company || "", /Example Industries/i);
assert.equal(parsed.ticker, "EXINDLTD");
assert.equal(parsed.seats.length, 2);
assert.equal(parsed.seats[0]?.name, "Alice Example");
assert.match(parsed.seats[0]?.designation || "", /Chairperson|Managing/i);

assert.equal(
  conflictingProductTokens(
    "Rajputana Industries Ltd",
    "Rajputana Biodiesel Limited",
  ),
  true,
);
assert.equal(
  scoreListingName(
    "Rajputana Industries Ltd",
    "RAJPUTANA",
    "Rajputana Biodiesel Limited",
  ),
  0,
);
assert.ok(
  scoreListingName(
    "Rajputana Industries Ltd",
    "RAJINDLTD",
    "Rajputana Industries Limited",
  ) >= 90,
);

console.log("ok");
