import assert from "node:assert/strict";
import { napkinDataStatus } from "../src/lib/napkin/status";
import { napkinSimpleFromStock } from "../src/lib/napkin/simple";
import { napkinMathNotes } from "../src/lib/napkin/format";
import type { NapkinStockJson } from "../src/lib/napkin/types";

assert.equal(
  napkinDataStatus({
    pe: null,
    requiredCagr: 0.1,
    price: 10,
    revenue: 1,
    netProfit: 1,
    eps: 1,
    threeYearCagrAvailable: true,
    fiveYearCagrAvailable: true,
  }),
  "insufficient",
);

assert.equal(
  napkinDataStatus({
    pe: 16,
    requiredCagr: 0.2,
    price: 10,
    revenue: 1,
    netProfit: 1,
    eps: 1,
    threeYearCagrAvailable: true,
    fiveYearCagrAvailable: false,
  }),
  "partial",
);

assert.equal(
  napkinDataStatus({
    pe: 16,
    requiredCagr: 0.2,
    price: 10,
    revenue: 1,
    netProfit: 1,
    eps: 1,
    threeYearCagrAvailable: true,
    fiveYearCagrAvailable: true,
  }),
  "complete",
);

const stub: NapkinStockJson = {
  ok: true,
  company_name: "Example Limited",
  ticker: "EXAMPLE",
  yf_symbol: "EXAMPLE.NS",
  price: 100,
  market_cap: 1e9,
  sector: "Industrials",
  fetched_at: "2026-01-01T00:00:00.000Z",
  pe: 10,
  eps: 10,
  revenue: 1e9,
  net_income: 1e8,
  ebitda: null,
  free_cash_flow: null,
  total_debt: null,
  cash: null,
  shares_outstanding: null,
  roe: 0.1,
  roce: 0.2,
  cagr: {
    revenue_3y: 0.1,
    revenue_5y: null,
    eps_3y: 0.12,
    eps_5y: null,
    profit_3y: 0.11,
    profit_5y: null,
  },
  margin: { current: 0.1, "3y": null, "5y": null },
  data_quality: {
    annualPeriodsAvailable: 4,
    requiredFor3Y: 4,
    requiredFor5Y: 6,
    threeYearCagrAvailable: true,
    fiveYearCagrAvailable: false,
    cagr_5y_source: "screener",
    reason: "Yahoo/Screener historical data unavailable",
    reasons: { revenue_5y: "Yahoo/Screener historical data unavailable" },
  },
};

const simple = napkinSimpleFromStock(stub);
assert.equal(simple.revenueCagr3y, 10);
assert.equal(simple.revenueCagr5y, null);
assert.equal(simple.dataStatus, "partial");
assert.ok(simple.sources.includes("Yahoo Finance"));
assert.ok(simple.sources.includes("Screener"));

assert.deepEqual(
  napkinMathNotes({
    historicalEpsCagr: "-23.2%",
    usedFiveYear: true,
    aboveHistory: true,
  }),
  [
    "EPS declined over the 5-year period",
    "Your assumption requires EPS growth significantly above history",
  ],
);
assert.deepEqual(
  napkinMathNotes({
    historicalEpsCagr: "12.0%",
    usedFiveYear: true,
  }),
  [],
);
console.log("ok");
