import assert from "node:assert/strict";
import { parseScreenshotBoard } from "../src/lib/din-screenshot-parse";

const ocr = `
Directors & Key Managerial Personnel of EXAMPLE CAPITAL
Current Directors & Key Managerial Personnel of EXAMPLE CAPITAL
DIN	Director Name	Designation	Appointment Date
Past Directors & Key Managerial Personnel of EXAMPLE CAPITAL
DIN	Director Name	Designation	Appointment Date	Cessation
00041032	Alice Example	Additional Director	-	2020-08-12
00041032	Alice Example	Director	-	2023-07-21
`;

const parsed = parseScreenshotBoard(ocr);
assert.equal(parsed.company, "EXAMPLE CAPITAL");
assert.equal(parsed.seats.length, 1);
assert.equal(parsed.seats[0]?.din, "00041032");
assert.equal(parsed.seats[0]?.name, "Alice Example");
assert.match(parsed.seats[0]?.designation || "", /Director/i);
console.log("ok");
