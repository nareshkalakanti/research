/**
 *   npx tsx test/eval-scores.test.ts
 */
import assert from "node:assert/strict";
import {
  countScoreBand,
  fundamentalScore,
  seriesCagr,
} from "../src/lib/fundamental-score";
import { managementScore } from "../src/lib/management-score";
import {
  evaluationFinalRating,
  grahamNumber,
  valuationScore,
} from "../src/lib/valuation-score";

// --- Fundamental ---
{
  const youngSales = [100, 115]; // ~15% 1Y
  const r = fundamentalScore({
    book_value: [10, 12, 14], // short hist → BV unknown/fail
    sales: youngSales,
    roce: 0.37,
    operating_profit: 28,
    interest: 2,
    fixed_assets: [7, 12], // 1.71×
    other_income: 9,
  });
  // sales pass, roce pass, interest pass, netblock fail, quality 9/162~5.5% pass, bv fail
  assert.equal(r.score, 4);
  assert.equal(r.band, "green");
}

{
  const cagr = seriesCagr([100, null, null, null, null, null, null, null, null, null, 200], 10);
  assert.ok(cagr != null && cagr > 0.07 && cagr < 0.08);
}

assert.equal(countScoreBand(5), "green");
assert.equal(countScoreBand(2), "yellow");
assert.equal(countScoreBand(0), "red");

// --- Management (Brandman-like) ---
{
  const r = managementScore({
    shareholder_counts: [541, 568, 628],
    pledged_pct: 0,
    fii_pct: 1.41,
    dii_pct: 5.91,
    promoter_pct: [69.02, 69.02, 69.02],
  });
  assert.equal(r.score, 2);
  assert.equal(r.band, "yellow");
}

// --- Management (Lehar-like) ---
{
  const prom: Array<number | null> = [];
  for (let i = 0; i < 13; i++) prom.push(i === 0 ? 70.8 : 72.9);
  const r = managementScore({
    shareholder_counts: [5749, 5679],
    pledged_pct: 0,
    fii_pct: 0.26,
    dii_pct: 1.1,
    promoter_pct: prom,
  });
  assert.equal(r.score, 4);
  assert.equal(r.band, "green");
}

// Holding investor needs meaningful FII+DII (≥1%), not a token stake.
{
  const r = managementScore({
    shareholder_counts: [4000, 4100],
    pledged_pct: 0,
    fii_pct: 0,
    dii_pct: 0.76,
    promoter_pct: [50, 50, 50],
  });
  // pledge only — token DII fails; promoters flat
  assert.equal(r.score, 1);
  assert.equal(
    r.rules.find((x) => x.id === "holding_investor")?.verdict,
    "fail",
  );
}

// Sales after structural jump without enough post-jump years → sales fail.
{
  const r = fundamentalScore({
    book_value: [10, 12, 40],
    equity_capital: [2, 2, 2],
    sales: [1, 2, 500, 520, 540], // mega jump then short hist
    roce: 0.2,
    operating_profit: 50,
    interest: 2,
    fixed_assets: [10, 12],
    other_income: 1,
  });
  const sales = r.rules.find((x) => x.id === "sales_cagr");
  assert.equal(sales?.verdict, "fail");
}

// --- Valuation / Graham ---
{
  const g = grahamNumber(10, 50);
  assert.ok(g != null && Math.abs(g - Math.sqrt(22.5 * 10 * 50)) < 1e-9);
  const cheap = valuationScore({
    price: 50,
    book_value_ps: 67,
    sales: 3000 * 1e7,
    market_cap: 1150 * 1e7,
    eps: 10,
    cash: 100,
    debt: 50,
    hist_eps_cagr: 0.2,
    required_eps_cagr: 0.1,
  });
  assert.ok(cheap.score >= 3);
  assert.equal(cheap.band, "green");
}

// Cash ≥ 50% of mcap counts as cash-rich even with large operating debt (NBFCs).
{
  const r = valuationScore({
    price: 70,
    book_value_ps: 180,
    sales: 140e9,
    market_cap: 11e9,
    eps: 14,
    cash: 12e9,
    debt: 100e9,
    hist_eps_cagr: 0.18,
    required_eps_cagr: 0.1,
  });
  assert.equal(r.rules.find((x) => x.id === "cash_rich")?.verdict, "pass");
  assert.ok(r.score >= 4);
}

assert.equal(evaluationFinalRating(9), "Good");
assert.equal(evaluationFinalRating(7), "Average");
assert.equal(evaluationFinalRating(3), "Weak");

console.log("eval-scores.test.ts: ok");
