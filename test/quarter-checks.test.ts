import assert from "node:assert/strict";
import { buildQuarterPanel, dropZeroSalesPlaceholders, type QuarterPoint } from "../src/lib/quarter-panel";
import { quarterChecks } from "../src/lib/quarter-checks";
import { quartersLookForeign } from "../src/lib/screener-quarters";

const q = (date: string, revenue: number | null): QuarterPoint => ({ date, revenue, netIncome: 1, eps: 1, ebit: 1 }) as QuarterPoint;
const dates = ["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"];

// ₹0 between real quarters is a placeholder → no data.
const z = dropZeroSalesPlaceholders(dates.map((d, i) => q(d, i === 2 ? 0 : 100)));
assert.equal(z[2]!.revenue, null);
assert.equal(z[1]!.revenue, 100);

const now = Date.UTC(2026, 10, 24);
// Consistent: 4 × 100 vs annual 400.
let c = quarterChecks(buildQuarterPanel(dates.map((d) => q(d, 100))), [380, 400], now);
assert.equal(c.mismatch, false);
assert.equal(c.breaks, false);
assert.equal(c.warning, null);

// Last 12 months 4× the annual report → mismatch, warning.
c = quarterChecks(buildQuarterPanel(dates.map((d) => q(d, 400))), [400], now);
assert.equal(c.mismatch, true);
assert.ok(c.warning);

// Tiny company, quarters 1000× the annual report (units mixed up) → mismatch.
c = quarterChecks(buildQuarterPanel(dates.map((d) => q(d, 4000))), [2], now);
assert.equal(c.mismatch, true);

// 100× jump between quarters → break.
c = quarterChecks(buildQuarterPanel(dates.map((d, i) => q(d, i < 3 ? 2 : 200))), null, now);
assert.equal(c.breaks, true);

// Latest result a year old → stale.
c = quarterChecks(buildQuarterPanel(["2025-03-31", "2025-06-30", "2025-09-30"].map((d) => q(d, 100))), null, now);
assert.equal(c.stale, true);

// Infosys in US dollars (~5,000 a quarter vs ₹1.6 lakh Cr a year) → not saved.
assert.equal(quartersLookForeign(dates.map((d) => q(d, 5000)), 162990), true);
assert.equal(quartersLookForeign(dates.map((d) => q(d, 40000)), 162990), false);
// Rupee series (₹ amounts) converts before comparing.
assert.equal(quartersLookForeign(dates.map((d) => q(d, 40000e7)), 162990), false);

console.log("quarter-checks ok");
