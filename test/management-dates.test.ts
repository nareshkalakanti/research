/**
 *   npx tsx test/management-dates.test.ts
 * Management score picks comparison points by date, not by column count.
 */
import assert from "node:assert/strict";
import { pointMonthsBack, previousFiling } from "../src/lib/portfolio-review";

const pts = (dates: string[], vals: number[]) => dates.map((d, i) => ({ d, v: vals[i]! }));

// PVR Inox: Screener adds an extra 2026-10-01 column right after 2026-09-30.
const pvr = pts(
  ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30", "2026-10-01"],
  [27.84, 27.84, 27.49, 27.49, 27.53, 27.53, 27.53, 27.53, 27.53, 27.53, 27.01, 27.6],
);
// "Quarterly" must not compare 30 Sep with 1 Oct.
assert.equal(previousFiling(pvr)!.d, "2026-06-30");
// 1 year back is Sep/Oct 2025, not Dec 2025.
assert.equal(pointMonthsBack(pvr, 12)!.p.d, "2025-09-30");
assert.equal(pointMonthsBack(pvr, 12)!.partial, false);

// 20 Microns: target is Sep 2023. Dec 2023 (3 months off) is within tolerance
// and closer than the yearly Mar 2023 point (6 months off).
const q20 = pts(
  ["2023-12-31", "2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"],
  [44.95, 44.95, 44.95, 44.99, 45.04, 45.04, 45.04, 45.04, 45.04, 45.04, 45.04, 45.04],
);
const y20 = pts(["2023-03-31", "2024-03-31"], [44.83, 44.95]);
const merged = [...y20.filter((y) => y.d < q20[0]!.d), ...q20];
const b3 = pointMonthsBack(merged, 36, 3)!;
assert.equal(b3.p.d, "2023-12-31");
assert.equal(b3.partial, false);
// Without a yearly table and only 8 quarters it is flagged partial, not silently "3 years".
const short = q20.slice(-8);
assert.equal(pointMonthsBack(short, 36, 3)!.partial, true);

// Ellen: 2016 columns, then a jump to 2025 — never compare with 2016.
const ellen = pts(
  ["2016-06-30", "2016-09-30", "2016-12-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"],
  [74.94, 74.94, 29.65, 77.16, 77.16, 77.16, 77.15, 77.15, 77.15],
);
const e3 = pointMonthsBack(ellen, 36, 3)!;
assert.equal(e3.p.d, "2025-06-30");
assert.equal(e3.partial, true);

// SEVL: half-yearly filer — previous filing is 6 months back, 1-year is exact.
const sevl = pts(["2025-06-30", "2025-09-30", "2026-03-31", "2026-09-30"], [1689, 1523, 1255, 1279]);
assert.equal(previousFiling(sevl)!.d, "2026-03-31");
assert.equal(pointMonthsBack(sevl, 12)!.p.d, "2025-09-30");

// Young listing: two filings only → partial, earliest after target.
const young = pts(["2026-06-30", "2026-09-30"], [100, 90]);
assert.deepEqual(pointMonthsBack(young, 12), { p: young[0], partial: true });
assert.equal(pointMonthsBack(pts(["2026-09-30"], [1]), 12), null);

console.log("management-dates ok");

// New listing: Screener's shareholding table has a single column.
import { parseScreenerShareholdingHtml } from "../src/lib/screener-shareholding";
{
  const html = `<section id="shareholding"><div id="quarterly-shp"><table class="data-table">
    <thead><tr><th></th><th>Sep 2026</th></tr></thead>
    <tbody>
      <tr><td>Promoters +</td><td>55.64%</td></tr>
      <tr><td>FIIs +</td><td>19.27%</td></tr>
      <tr><td>DIIs +</td><td>9.18%</td></tr>
      <tr><td>Public +</td><td>15.91%</td></tr>
      <tr><td>No. of Shareholders</td><td>1,53,842</td></tr>
    </tbody></table></div></section>`;
  const s = parseScreenerShareholdingHtml(html);
  assert.deepEqual(s.dates, ["2026-09-01"]);
  assert.equal(s.promoters[0], 55.64);
  assert.equal(s.fii[0], 19.27);
  assert.equal(s.shareholders[0], 153842);
  assert.equal(s.pledged_pct, 0);
  console.log("single-column shareholding ok");
}
