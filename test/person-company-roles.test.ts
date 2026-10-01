import assert from "node:assert/strict";
import { parsePersonCompanyRoles } from "../src/lib/din-screenshot-parse";

const rows = parsePersonCompanyRoles(
  "Pinky Atul Mehta (00020429) - director on the board of Aditya Birla Money & Chief Financial Officer (CFO) - Aditya Birla Capital Limited,",
);
assert.equal(rows.length, 2);
assert.equal(rows[0]!.din, "00020429");
assert.equal(rows[0]!.designation, "Director");
assert.match(rows[0]!.company, /Aditya Birla Money/i);
assert.equal(rows[1]!.designation, "CFO");
assert.match(rows[1]!.company, /Aditya Birla Capital/i);
console.log("ok");
