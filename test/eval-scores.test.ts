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
    dii_pct: 0,
    promoter_pct: prom,
  });
  assert.equal(r.score, 4);
  assert.equal(r.band, "green");
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

assert.equal(evaluationFinalRating(9), "Good");
assert.equal(evaluationFinalRating(7), "Average");
assert.equal(evaluationFinalRating(3), "Weak");

console.log("eval-scores.test.ts: ok");
