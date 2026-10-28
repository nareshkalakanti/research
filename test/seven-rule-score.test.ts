/**
 *   npx tsx test/seven-rule-score.test.ts
 */
import assert from "node:assert/strict";
import {
  sevenRuleFromPanel,
  sevenRuleRatingFromPassed,
  sevenRuleScore,
} from "../src/lib/seven-rule-score";
import { buildQuarterPanel, type QuarterPoint } from "../src/lib/quarter-panel";

assert.equal(sevenRuleRatingFromPassed(7).ratingLabel, "STRONG BUY");
assert.equal(sevenRuleRatingFromPassed(6).ratingLabel, "BUY");
assert.equal(sevenRuleRatingFromPassed(5).ratingLabel, "DEEP DIVE");
assert.equal(sevenRuleRatingFromPassed(4).ratingLabel, "NO");
assert.equal(sevenRuleRatingFromPassed(0).ratingLabel, "NO");
assert.equal(sevenRuleRatingFromPassed(4).rating, "no");
assert.equal(roundCheck(4), 5.71);
assert.equal(roundCheck(5), 7.14);
assert.equal(roundCheck(6), 8.57);
assert.equal(roundCheck(7), 10);

function roundCheck(passed: number): number {
  return Math.round((passed / 7) * 1000) / 100;
}

const allPass = sevenRuleScore({
  roce: 0.2,
  roe: 0.2,
  sales: [100, 120, 140],
  profit: [10, 12, 15],
  opm: [10, 11, 12],
  labels: ["Mar 2023", "Jun 2023", "Mar 2024"],
  order: "newest-last",
});
assert.equal(allPass.passed, 7);
assert.equal(allPass.score, 10);
assert.equal(allPass.rating, "strong_buy");
assert.equal(allPass.ratingLabel, "STRONG BUY");
assert.equal(allPass.provisional, false);

const sixOfSeven = sevenRuleScore({
  roce: 0.14,
  roe: 0.18,
  sales: [100, 110, 125],
  profit: [10, 11, 13],
  opm: [12, 13, 15],
  labels: ["Mar 2023", "Jun 2023", "Mar 2024"],
  order: "newest-last",
});
assert.equal(sixOfSeven.passed, 6);
assert.equal(sixOfSeven.score, 8.57);
assert.equal(sixOfSeven.rating, "buy");
assert.equal(sixOfSeven.provisional, false);

const fivePass = sevenRuleScore({
  roce: 0.1, // fail
  roe: 0.2,
  sales: [100, 110, 111], // QoQ fail (~0.9%), YoY pass
  profit: [10, 11, 13],
  opm: [12, 13, 15],
  labels: ["Mar 2023", "Jun 2023", "Mar 2024"],
  order: "newest-last",
});
assert.equal(fivePass.passed, 5);
assert.equal(fivePass.score, 7.14);
assert.equal(fivePass.rating, "deep_dive");
assert.equal(fivePass.ratingLabel, "DEEP DIVE");

const fourPass = sevenRuleScore({
  roce: 0.1, // fail
  roe: 0.1, // fail
  sales: [100, 110, 111], // QoQ fail, YoY pass
  profit: [10, 11, 13],
  opm: [12, 13, 15],
  labels: ["Mar 2023", "Jun 2023", "Mar 2024"],
  order: "newest-last",
});
assert.equal(fourPass.passed, 4);
assert.equal(fourPass.score, 5.71);
assert.equal(fourPass.rating, "no");
assert.equal(fourPass.ratingLabel, "NO");

const unknownGrowth = sevenRuleScore({
  roce: 0.2,
  roe: 0.2,
  sales: [100, 0, 120],
  profit: [10, -5, 12],
  opm: [10, 11],
  order: "newest-last",
});
assert.ok(unknownGrowth.rules.some((r) => r.verdict === "unknown"));
assert.equal(unknownGrowth.provisional, true);
assert.equal(unknownGrowth.rating, null);
assert.equal(unknownGrowth.ratingLabel, null);

const lossPrior = sevenRuleScore({
  roce: 0.2,
  roe: 0.2,
  sales: [100, 120],
  profit: [-5, 10],
  opm: [10, 12],
  order: "newest-last",
});
const pq = lossPrior.rules.find((r) => r.id === "profit_qoq");
assert.equal(pq?.verdict, "unknown");
assert.equal(lossPrior.provisional, true);
assert.equal(lossPrior.rating, null);

const oldestLastBaseline = sevenRuleScore({
  roce: 0.16,
  roe: 0.16,
  sales: [100, 110, 125],
  profit: [10, 11, 13],
  opm: [13, 14, 15],
  labels: ["Mar 2023", "Jun 2023", "Mar 2024"],
  order: "newest-last",
});
const newestFirst = sevenRuleScore({
  roce: 0.16,
  roe: 0.16,
  sales: [125, 110, 100],
  profit: [13, 11, 10],
  opm: [15, 14, 13],
  labels: ["Mar 2024", "Jun 2023", "Mar 2023"],
  dates: ["2024-03-31", "2023-06-30", "2023-03-31"],
});
assert.equal(newestFirst.passed, oldestLastBaseline.passed);
assert.equal(newestFirst.score, oldestLastBaseline.score);

const quarters: QuarterPoint[] = [
  { date: "2023-03-31", revenue: 100, netIncome: 10, eps: 1, ebit: 20 },
  { date: "2023-06-30", revenue: 110, netIncome: 11, eps: 1.1, ebit: 22 },
  { date: "2023-09-30", revenue: 120, netIncome: 12, eps: 1.2, ebit: 24 },
  { date: "2024-03-31", revenue: 115, netIncome: 11, eps: 1.1, ebit: 23 },
  { date: "2024-06-30", revenue: 130, netIncome: 14, eps: 1.4, ebit: 28 },
];
const panel = buildQuarterPanel(quarters);
assert.ok(panel);
const fromPanel = sevenRuleFromPanel(panel, { roce: 0.2, roe: 0.2 });
assert.ok(fromPanel);
assert.ok(fromPanel!.passed >= 1);

console.log("seven-rule-score.test.ts: ok");
