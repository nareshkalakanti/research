import assert from "node:assert/strict";
import { parseScreenshotBoard } from "../src/lib/din-screenshot-parse";

/** Research chat / archives table: For COMPANY (NSE SME) + Director | Role | DIN */
const ocr = `
For Example Biodiesel Ltd (NSE SME), the current directors' DINs are:

Director	Role	DIN
Alice Example	Executive Chairman & Whole-Time Director, Promoter	00167178
archives.nseindia +1
Bob Example	Managing Director & CFO, Promoter	07633751
Carol Example	Whole-Time Director, Promoter	07633730
Dana Example	Non-Executive Director, Promoter	10249776
Eve Example	Non-Executive Independent Director	10705131
Frank Example	Non-Executive Independent Director	10705230
`;

const spaced = `
For Example Fuels Limited (BSE SME), the current directors' DINs are:
Director Role DIN
Grace Example Executive Chairman & Whole-Time Director, Promoter 00167178
`;

const parsed = parseScreenshotBoard(ocr);
assert.match(parsed.company || "", /Example Biodiesel/i);
assert.equal(parsed.ticker, null);
assert.equal(parsed.seats.length, 6);
assert.equal(parsed.seats[0]?.din, "00167178");
assert.equal(parsed.seats[0]?.name, "Alice Example");
assert.match(parsed.seats[0]?.designation || "", /Executive Chairman/i);
assert.equal(parsed.seats[1]?.name, "Bob Example");
assert.match(parsed.seats[1]?.designation || "", /Managing Director/i);
assert.equal(parsed.seats[5]?.din, "10705230");
assert.equal(parsed.seats[5]?.name, "Frank Example");

const spacedParsed = parseScreenshotBoard(spaced);
assert.match(spacedParsed.company || "", /Example Fuels/i);
assert.equal(spacedParsed.seats.length, 1);
assert.equal(spacedParsed.seats[0]?.name, "Grace Example");
assert.match(spacedParsed.seats[0]?.designation || "", /Executive Chairman/i);

console.log("ok");
