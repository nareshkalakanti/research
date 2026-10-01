import assert from "node:assert/strict";
import { parseScreenshotBoard } from "../src/lib/din-screenshot-parse";

const text = `
Key Executive & Independent Board DINs
• 01249904 - Alice Example
  Designation: Managing Director (MD) & Chief Executive Officer (CEO)
  Role: Core executive promoter leading operations.
• 00023260 - Bob Example
  Designation: Chairman
• 11640370 - Dr. Carol Example
  Designation: Additional Non-Executive Independent Director
`;

const parsed = parseScreenshotBoard(text);
const byDin = new Map(parsed.seats.map((s) => [s.din, s]));
assert.equal(byDin.get("01249904")?.name, "Alice Example");
assert.match(byDin.get("01249904")?.designation || "", /Managing Director/i);
assert.equal(byDin.get("00023260")?.name, "Bob Example");
assert.match(byDin.get("00023260")?.designation || "", /Chair/i);
assert.equal(byDin.get("11640370")?.name, "Dr. Carol Example");
assert.match(byDin.get("11640370")?.designation || "", /Independent/i);
assert.equal(parsed.seats.length, 3);
console.log("ok");
