/**
 * Quarterly panel unit tests (no network) — PEAD-aligned helpers.
 * Run: npm run test:quarters
 */
import assert from "node:assert/strict";
import {
  buildQuarterPanel,
  inrCroreDivisor,
  qCellClass,
  trimReportedQuarters,
  type QuarterPoint,
} from "../src/lib/quarter-panel";

function growingSeries(): QuarterPoint[] {
  const base = [
    { date: "2024-06-30", rev: 100e7, np: 10e7, eps: 1.0, ebit: 15e7 },
    { date: "2024-09-30", rev: 105e7, np: 11e7, eps: 1.1, ebit: 16e7 },
    { date: "2024-12-31", rev: 110e7, np: 12e7, eps: 1.2, ebit: 17e7 },
    { date: "2025-03-31", rev: 115e7, np: 12.5e7, eps: 1.25, ebit: 18e7 },
    { date: "2025-06-30", rev: 125e7, np: 14e7, eps: 1.4, ebit: 20e7 },
  ];
  return base.map((b) => ({
    date: b.date,
    revenue: b.rev,
    netIncome: b.np,
    eps: b.eps,
    ebit: b.ebit,
  }));
}

function main() {
  assert.equal(inrCroreDivisor([100e7, 200e7]), 1e7);
  assert.equal(inrCroreDivisor([100, 200]), 1);

  const future: QuarterPoint[] = [
    ...growingSeries(),
    {
      date: "2099-03-31",
      revenue: 999e7,
      netIncome: 1,
      eps: 1,
      ebit: 1,
    },
  ];
  const trimmed = trimReportedQuarters(future, new Date("2026-08-10"));
  assert.ok(!trimmed.some((q) => q.date.startsWith("2099")));
  assert.ok(trimmed.length >= 5);

  const panel = buildQuarterPanel(growingSeries());
  assert.ok(panel);
  assert.equal(panel!.labels.length, 5);
  assert.equal(panel!.rows[0]!.label, "Sales");
  assert.equal(panel!.rows[0]!.values[0], 100);
  assert.equal(panel!.rows[1]!.label, "Operating Profit");
  assert.equal(panel!.rows.at(-1)!.label, "EPS in Rs");
  assert.equal(panel!.rows.at(-1)!.values[4], 1.4);
  assert.equal(qCellClass(panel!.rows[0]!, 4), "q-up");

  const withOi = growingSeries().map((q, i) => ({
    ...q,
    otherIncome: i === 4 ? 5e7 : 0,
  }));
  const p2 = buildQuarterPanel(withOi);
  assert.ok(p2!.rows.some((r) => r.label === "Other Income"));

  assert.equal(buildQuarterPanel([]), null);
  console.log("test-quarters: all passed");
}

main();
