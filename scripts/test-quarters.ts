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
  yoyFromPanel,
  yoyPct,
  fmtYoYPct,
} from "../src/lib/quarter-panel";
import { parseNonIndAsQuarterXbrl } from "../src/lib/nse-quarters";
import {
  computeForwardPe,
  computeTrailingPe,
} from "../src/lib/valuation";

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

  const nonIndXml = `<?xml version="1.0"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance">
<xbrli:context id="OneD"><xbrli:period><xbrli:endDate>2024-03-31</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="FourD"><xbrli:period><xbrli:endDate>2024-03-31</xbrli:endDate></xbrli:period></xbrli:context>
<RevenueFromOperations contextRef="OneD">483620000</RevenueFromOperations>
<ProfitLossForThePeriod contextRef="OneD">41703000</ProfitLossForThePeriod>
<BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations contextRef="OneD">3.17</BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations>
<RevenueFromOperations contextRef="FourD">1011029000</RevenueFromOperations>
<ProfitLossForThePeriod contextRef="FourD">88518000</ProfitLossForThePeriod>
</xbrli:xbrl>`;
  const parsed = parseNonIndAsQuarterXbrl(nonIndXml, { fallbackEnd: "2024-03-31" });
  assert.ok(parsed.oneD);
  assert.equal(parsed.oneD!.revenue, 483620000);
  assert.equal(parsed.oneD!.netIncome, 41703000);
  assert.equal(parsed.oneD!.eps, 3.17);
  assert.equal(parsed.fourD!.revenue, 1011029000);

  const eps = [0.3, 0.36, 4.47, 13.38];
  assert.equal(computeForwardPe(475, eps), 8.9);
  assert.equal(computeTrailingPe(475, eps), 25.7);
  assert.equal(computeForwardPe(100, [-1, -2]), 999);

  const yoyPanel = buildQuarterPanel(growingSeries());
  assert.ok(yoyPanel);
  const yoy = yoyFromPanel(yoyPanel!);
  assert.ok(yoy);
  assert.equal(yoy!.sales_yoy, 25);
  assert.equal(yoy!.eps_yoy, 40);
  assert.equal(yoyPct(140, 100), 40);
  assert.equal(yoyPct(4.48, -0.56), null);
  assert.equal(fmtYoYPct(12.5), "+12.5%");
  assert.equal(fmtYoYPct(null), "N/M");

  const pnbLike: QuarterPoint[] = [
    { date: "2024-12-31", revenue: 316e7, netIncome: -10e7, eps: -0.56, ebit: 302e7 },
    { date: "2025-03-31", revenue: 299e7, netIncome: 75e7, eps: null, ebit: 366e7 },
    { date: "2025-06-30", revenue: 563e7, netIncome: 160e7, eps: 8.89, ebit: 537e7 },
    { date: "2025-12-31", revenue: 410e7, netIncome: 54e7, eps: 2.99, ebit: 394e7 },
    { date: "2026-06-30", revenue: 455e7, netIncome: 81e7, eps: 4.48, ebit: 439e7 },
  ];
  const pnbPanel = buildQuarterPanel(pnbLike);
  const pnbYoy = yoyFromPanel(pnbPanel!);
  assert.ok(pnbYoy);
  assert.equal(pnbYoy!.eps_yoy, -49.6);
  assert.equal(pnbYoy!.sales_yoy, -19.2);

  console.log("test-quarters: all passed");
}

main();
