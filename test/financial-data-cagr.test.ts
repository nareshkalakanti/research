import assert from "node:assert/strict";
import {
  annualCagr,
  cagr,
  nseYahooSymbol,
  REQUIRED_ANNUAL_POINTS_5Y,
  REASON_SHORT_5Y,
} from "../src/lib/napkin/financials";
import { alignedYearPairs, fiscalYearLabel } from "../src/lib/napkin/cagr-history";
import { parseGrowwYearlyFinancialStatement } from "../src/lib/groww-quarters";

assert.equal(nseYahooSymbol("abc"), "ABC.NS");
assert.ok(Math.abs((cagr(100, 121, 2) ?? NaN) - 0.1) < 1e-9);
assert.equal(cagr(-1, 2, 3), null);
assert.equal(cagr(0, 10, 5), null);

const four = [10, 12, 14, 16];
const y3 = annualCagr(four, 3);
assert.ok(y3.value != null);
assert.equal(annualCagr(four, 5).value, null);
assert.equal(annualCagr(four, 5).reason, REASON_SHORT_5Y);
const fakeFive = (16 / 10) ** (1 / 5) - 1;
assert.notEqual(annualCagr(four, 5).value, fakeFive);

const six = [8, 9, 10, 12, 14, 16];
assert.equal(six.length, REQUIRED_ANNUAL_POINTS_5Y);
assert.ok(annualCagr(six, 5).value != null);
assert.ok(Math.abs(annualCagr(six, 5).value! - ((16 / 8) ** (1 / 5) - 1)) < 1e-12);

assert.equal(fiscalYearLabel("Mar 2021"), "2021");
const sc = alignedYearPairs(
  ["Mar 2021", "Mar 2022", "Mar 2023", "Mar 2024", "Mar 2025", "Mar 2026"],
  [10, 12, 14, 16, 18, 22],
);
assert.equal(sc.length, REQUIRED_ANNUAL_POINTS_5Y);
assert.ok(annualCagr(sc.map(([, v]) => v), 5).value != null);

const growwY = parseGrowwYearlyFinancialStatement({
  financialStatementV2: {
    CONSOLIDATED: [
      {
        title: "Revenue",
        yearly: {
          "Mar '21": 10,
          "Mar '22": 12,
          "Mar '23": 14,
          "Mar '24": 16,
          "Mar '25": 18,
          "Mar '26": 22,
        },
      },
    ],
  },
});
assert.equal(growwY.length, 6);
assert.equal(growwY[0]!.year, "2021");

console.log("ok");
