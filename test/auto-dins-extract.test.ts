import assert from "node:assert/strict";
import { extractDinHitsFromText } from "../src/lib/auto-dins";

const text = `
Board of Directors
Mr. Alice Example (DIN: 02467557)
Bob Example DIN 07633751
Whole-time Director
Carol Example DIN: 10249776
`;

const hits = extractDinHitsFromText(text);
const byDin = new Map(hits.map((h) => [h.din, h.name]));
assert.equal(byDin.get("02467557"), "Alice Example");
assert.equal(byDin.get("07633751"), "Bob Example");
assert.equal(byDin.get("10249776"), "Carol Example");
assert.equal(hits.length, 3);
console.log("ok");
