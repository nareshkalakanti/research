/**
 * NSE equity list CSV parse — gold rows are fixtures, not production issuers.
 */
import assert from "node:assert/strict";
import {
  isNseRightsEntitlement,
  nseSmeIssuers,
  parseNseEquityListCsv,
} from "../src/lib/nse-equity-lists";

const csv = `SYMBOL,NAME_OF_COMPANY,SERIES,DATE_OF_LISTING,PAID_UP_VALUE,ISIN_NUMBER
ABH,ABH Healthcare Limited,SM,01-Sep-26,10,INE1R2M01019
PARTY-RE,Party Cruisers Ltd-RE,ST,29-Sep-26,2,INE06ZX20015
RELIANCE,Reliance Industries Limited,EQ,29-Nov-1995,10,INE002A01018
`;

const rows = parseNseEquityListCsv(csv);
assert.equal(rows.length, 3);
assert.equal(rows[0]?.ticker, "ABH");
assert.equal(rows[0]?.isin, "INE1R2M01019");
assert.equal(isNseRightsEntitlement(rows[1]!), true);
assert.equal(isNseRightsEntitlement(rows[0]!), false);
const issuers = nseSmeIssuers(rows);
assert.deepEqual(
  issuers.map((r) => r.ticker),
  ["ABH", "RELIANCE"],
);
assert.ok(!issuers.some((r) => r.ticker === "PARTY-RE"));

console.log("nse-equity-lists.test.ts ok");
