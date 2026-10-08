/**
 * Yahoo absolute ₹ must not wipe Screener ₹ Cr when stitched into one panel.
 */
import assert from "node:assert/strict";
import {
  alignQuarterSeriesUnits,
  buildQuarterPanel,
  mergeQuarterFill,
  normalizeQuarterPointToCrore,
  type QuarterPoint,
} from "../src/lib/quarter-panel";
import { mergeScreenerQuarterOverlay } from "../src/lib/screener-quarters";

const yahooish: QuarterPoint[] = [
  {
    date: "2025-06-30",
    revenue: 265,
    ebit: 27,
    netIncome: 15,
    eps: 2.4,
    otherIncome: 0,
  },
  {
    date: "2025-09-30",
    revenue: 2_858_680_000,
    ebit: 219_330_000,
    netIncome: 154_330_000,
    eps: 3.057,
    otherIncome: 20_420_000,
  },
  {
    date: "2025-12-31",
    revenue: 269,
    ebit: 29,
    netIncome: 17,
    eps: 2.12,
    otherIncome: 0,
  },
];

const screener: QuarterPoint[] = [
  {
    date: "2025-06-30",
    revenue: 265,
    ebit: 27,
    netIncome: 15,
    eps: 2.4,
    otherIncome: 0,
  },
  {
    date: "2025-12-31",
    revenue: 269,
    ebit: 29,
    netIncome: 17,
    eps: 2.12,
    otherIncome: 0,
  },
];

const sepCr = normalizeQuarterPointToCrore(yahooish[1]!);
assert.equal(sepCr.revenue, 285.87);
assert.equal(sepCr.ebit, 21.93);
assert.equal(sepCr.netIncome, 15.43);

const [normYahoo] = alignQuarterSeriesUnits(yahooish, screener);
assert.ok(normYahoo[1]!.revenue != null && normYahoo[1]!.revenue! < 1e5);

const merged = mergeScreenerQuarterOverlay(yahooish, screener);
const panel = buildQuarterPanel(merged);
assert.ok(panel);
const sales = panel!.rows.find((r) => r.label === "Sales")!.values;
// Must not collapse Cr quarters to 0 because one Yahoo cell was absolute ₹.
assert.deepEqual(sales, [265, 286, 269]);

const filled = mergeQuarterFill(
  [
    {
      date: "2025-09-30",
      revenue: 2_858_680_000,
      ebit: null,
      netIncome: null,
      eps: null,
    },
  ],
  [
    {
      date: "2025-09-30",
      revenue: null,
      ebit: 22,
      netIncome: 15,
      eps: 3,
    },
  ],
);
assert.ok(filled[0]!.revenue != null && filled[0]!.revenue! < 1e5);
assert.equal(filled[0]!.ebit, 22);

console.log("quarter-units.test.ts: ok");
