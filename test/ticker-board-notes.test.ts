import assert from "node:assert/strict";
import { parseTickerBoardNotes } from "../src/lib/din-screenshot-parse";

const text = `
1. Northwind Steels Limited (NORTHSTEEL)
• Ada Northwind (Chairman) | DIN: 00011111
• Beau Northwind (Managing Director) | DIN: 00022222
2. Northwind Power Limited (NORTHPWR)
• Ada Northwind (Chairman) | DIN: 00011111
• Cal Northwind (Director) | DIN: 00033333
`;

const chunks = parseTickerBoardNotes(text);
assert.equal(chunks.length, 2);
assert.equal(chunks[0]!.ticker, "NORTHSTEEL");
assert.equal(chunks[0]!.seats.length, 2);
assert.equal(chunks[0]!.seats[0]!.name, "Ada Northwind");
assert.equal(chunks[0]!.seats[0]!.din, "00011111");
assert.match(chunks[0]!.seats[0]!.designation, /Chair/i);
assert.equal(chunks[1]!.ticker, "NORTHPWR");
assert.equal(chunks[1]!.seats[1]!.din, "00033333");
console.log("ticker-board-notes: ok");
