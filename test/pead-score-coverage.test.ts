/**
 *   npx tsx test/pead-score-coverage.test.ts
 */
import assert from "node:assert/strict";
import {
  peadScoreAbsolute,
  peadScoreFfMonitor,
  peadScoresPercentile,
  type PeadInputs,
} from "../src/lib/pead-score";

const blank: PeadInputs = {
  returns_pct: null,
  sales_yoy: null,
  sales_qoq: null,
  np_yoy: null,
  np_qoq: null,
  eps_yoy: null,
  eps_qoq: null,
  ebidt_yoy: null,
  ebidt_qoq: null,
  forward_pe: null,
  cf_profit: null,
};

const full = (g: number, pe: number): PeadInputs => ({
  returns_pct: g / 2,
  sales_yoy: g,
  sales_qoq: g,
  np_yoy: g,
  np_qoq: g,
  eps_yoy: g,
  eps_qoq: g,
  ebidt_yoy: g,
  ebidt_qoq: g,
  forward_pe: pe,
  cf_profit: 1,
});

// Thin row (2 metrics) no longer outranks full rows — it gets no score.
const scores = peadScoresPercentile([
  full(10, 20),
  full(30, 15),
  { ...blank, np_qoq: 500, returns_pct: 50 },
]);
assert.equal(scores[2], null);
assert.ok(scores[1]! > scores[0]!);

// Loss-making PE (999) is ranked worst, below the most expensive usable PE.
const pe = peadScoresPercentile([
  { ...blank, sales_yoy: 10, np_yoy: 10, forward_pe: 999 },
  { ...blank, sales_yoy: 10, np_yoy: 10, forward_pe: 80 },
]);
assert.ok(pe[0]! < pe[1]!);

// Absolute: needs ≥50% of weight; N/M PE scores 0, not missing.
assert.equal(peadScoreAbsolute({ ...blank, sales_yoy: 50 }), null);
const cheap = peadScoreAbsolute({ ...blank, sales_yoy: 50, np_yoy: 50, np_qoq: 50, forward_pe: 15 });
const nm = peadScoreAbsolute({ ...blank, sales_yoy: 50, np_yoy: 50, np_qoq: 50, forward_pe: 999 });
assert.ok(cheap! > nm!);

// FF monitor parity — MAN INDUSTRIES Q2 FY27 FinanciallyFree card:
// Sales 1,210.35 vs 834.09 YoY / 1,053.13 QoQ → PEAD 48.3 (FF PE ≈ 12.38).
const salesYoy = (1210.35 / 834.09 - 1) * 100;
const salesQoq = (1210.35 / 1053.13 - 1) * 100;
assert.equal(peadScoreFfMonitor(salesYoy, salesQoq, 12.38), 48.3);
// No PE bonus at PE ≥ 20; falls back to NP when sales missing.
assert.equal(peadScoreFfMonitor(10, 20, 25), 15);
assert.equal(peadScoreFfMonitor(null, null, 10), null);

console.log("pead-score-coverage ok");
