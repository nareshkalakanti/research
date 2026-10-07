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
assert.equal(nseYahooSymbol("VIVIDEL", "NSE SME"), "VIVIDEL-SM.NS");
assert.equal(nseYahooSymbol("VIVIDEL", "NSE"), "VIVIDEL.NS");
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

import {
  DEFAULT_NAPKIN_SCAN_FILTER,
  napkinScanQuoteNote,
  napkinScanStatus,
  orderTickersForPeScan,
  passesNapkinScanFilters,
  type NapkinStockScanRow,
} from "../src/lib/napkin/scan-filters";
import {
  epsGrowthGap5y,
  epsHistoryFromAnnual,
  napkinStockScanRow,
  passesMinEpsHistory,
} from "../src/lib/napkin/eps-history";
import { napkinRequiredEpsCagr } from "../src/lib/napkin/engine";

const five = epsHistoryFromAnnual([10, 12, 14, 16, 18, 22]);
assert.equal(five.history, "5Y");
assert.ok(five.eps_5y != null && five.eps_3y != null && five.eps_1y != null);
const fiveRow = napkinStockScanRow({
  ticker: "FIVE",
  name: "Five Year Co",
  eps: [10, 12, 14, 16, 18, 22],
  pe: 20,
});
assert.equal(fiveRow.history, "5Y");
assert.equal(fiveRow.warning, null);
assert.ok(fiveRow.required_cagr != null);
assert.equal(fiveRow.required_cagr, napkinRequiredEpsCagr(20));
assert.ok(
  Math.abs((fiveRow.growth_gap ?? NaN) - (five.eps_5y! - fiveRow.required_cagr!)) < 1e-12,
);

const three = napkinStockScanRow({
  ticker: "THREE",
  name: "Three Year Co",
  eps: [10, null, 12, 14, 16],
  pe: 20,
});
assert.equal(three.history, "3Y");
assert.equal(three.eps_5y, null);
assert.ok(three.eps_3y != null);
assert.equal(three.growth_gap, null);
assert.ok(three.required_cagr != null);
assert.equal(three.warning, "Less than 5 years of EPS history");
assert.notEqual(three.eps_3y, (16 / 10) ** (1 / 5) - 1);
assert.equal(epsHistoryFromAnnual([0, 10]).history, "Insufficient");

const one = napkinStockScanRow({
  ticker: "ONE",
  name: "One Year Co",
  eps: [10, 12],
  pe: 20,
});
assert.equal(one.history, "1Y");
assert.equal(one.eps_3y, null);
assert.equal(one.eps_5y, null);
assert.equal(one.growth_gap, null);
assert.equal(one.warning, "Limited financial history");
assert.ok(Math.abs((one.eps_1y ?? NaN) - (12 / 10 - 1)) < 1e-12);

const none = epsHistoryFromAnnual([null, 0, -2]);
assert.equal(none.history, "Insufficient");
assert.equal(epsGrowthGap5y(null, 0.2), null);
assert.equal(passesMinEpsHistory("3Y", "5Y"), false);
assert.equal(passesMinEpsHistory("3Y", "3Y"), true);
assert.equal(passesMinEpsHistory("5Y", "3Y"), true);
assert.equal(passesMinEpsHistory("1Y", "any"), true);

const rich = napkinStockScanRow({
  ticker: "RICH",
  eps: [8, 9, 10, 12, 14, 16],
  sales: [10, 12, 14, 16],
  roce: [null, 11, null],
  market_cap_cr: 500,
  pe: 20,
});
assert.equal(rich.revenue_cagr_5y, null);
assert.equal(rich.roce, 11);
assert.equal(rich.market_cap_cr, 500);
assert.ok(rich.eps_5y != null && rich.required_cagr != null);
assert.ok(Math.abs((rich.growth_gap ?? NaN) - (rich.eps_5y! - rich.required_cagr!)) < 1e-12);
const openFilter = {
  history: "5Y" as const,
  mcapMin: null,
  mcapMax: null,
  peMax: null,
  eps5Min: null,
  eps3Min: null,
  rev5Min: null,
  roceMin: null,
  gapMin: null,
};
assert.equal(passesNapkinScanFilters(rich, openFilter), true);
assert.equal(passesNapkinScanFilters(rich, { ...openFilter, rev5Min: 0.1 }), false);
assert.equal(passesNapkinScanFilters(rich, { ...openFilter, roceMin: 12 }), false);
assert.equal(passesNapkinScanFilters(rich, { ...openFilter, mcapMin: 1000 }), false);
assert.equal(DEFAULT_NAPKIN_SCAN_FILTER.history, "5Y");
assert.equal(DEFAULT_NAPKIN_SCAN_FILTER.mcapMin, null);
assert.equal(DEFAULT_NAPKIN_SCAN_FILTER.mcapMax, null);
assert.equal(DEFAULT_NAPKIN_SCAN_FILTER.peMax, 40);
assert.equal(DEFAULT_NAPKIN_SCAN_FILTER.eps5Min, 0.15);
assert.equal(DEFAULT_NAPKIN_SCAN_FILTER.eps3Min, 0.1);
assert.equal(DEFAULT_NAPKIN_SCAN_FILTER.rev5Min, 0.1);
assert.equal(DEFAULT_NAPKIN_SCAN_FILTER.roceMin, 15);
assert.equal(DEFAULT_NAPKIN_SCAN_FILTER.gapMin, -0.1);
assert.equal(passesNapkinScanFilters(rich, DEFAULT_NAPKIN_SCAN_FILTER), false);
assert.equal(passesNapkinScanFilters(rich, { ...openFilter, eps3Min: 0.1 }), true);
assert.equal(rich.buy_price, null);
assert.equal(rich.eps, null);

const screened: NapkinStockScanRow = {
  ...rich,
  eps_5y: 0.2,
  eps_3y: 0.12,
  revenue_cagr_5y: 0.11,
  roce: 18,
  market_cap_cr: 800,
  pe: 20,
  required_cagr: 0.15,
  growth_gap: 0.05,
  price: 100,
  eps: 5,
  buy_price: 100,
};
assert.equal(napkinScanStatus(screened, DEFAULT_NAPKIN_SCAN_FILTER), "Research");
assert.equal(
  napkinScanStatus({ ...screened, market_cap_cr: 50 }, DEFAULT_NAPKIN_SCAN_FILTER),
  "Research",
  "no market cap limit by default",
);
assert.equal(
  napkinScanStatus({ ...screened, market_cap_cr: null }, DEFAULT_NAPKIN_SCAN_FILTER),
  "Research",
);
assert.equal(
  napkinScanStatus({ ...screened, growth_gap: -0.04 }, DEFAULT_NAPKIN_SCAN_FILTER),
  "Watch",
);
assert.equal(
  napkinScanStatus({ ...screened, growth_gap: null }, DEFAULT_NAPKIN_SCAN_FILTER),
  "N/A",
);
assert.equal(
  napkinScanStatus({ ...screened, eps_3y: null }, DEFAULT_NAPKIN_SCAN_FILTER),
  "N/A",
);
assert.equal(napkinScanQuoteNote(0, 10), "Financial data loaded · Live quotes available");
assert.equal(napkinScanQuoteNote(10, 10), "Financial data loaded · Live quotes unavailable");
assert.equal(napkinScanQuoteNote(3, 10), "Partial data · 3 stocks could not be refreshed");
assert.deepEqual(
  orderTickersForPeScan(
    ["BBB", "AAA", "CCC"],
    new Set(["CCC"]),
    new Map([
      ["AAA", 800],
      ["BBB", 100],
    ]),
    { min: 500, max: 20_000 },
  ),
  ["AAA", "BBB"],
);

console.log("ok");
