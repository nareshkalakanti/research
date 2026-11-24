import assert from "node:assert/strict";
import { bookValuePerShare, businessBreak, cagrCheck, roceAverage } from "../src/lib/napkin/quality-flags";
import { peerMedian } from "../src/lib/portfolio-review";
import { peersTableLacksColumns } from "../src/lib/screener-peers";

// NIIT MTS: shell (₹13 Cr) takes in the demerged business (₹1,132 Cr) in FY2022.
const dates = ["2015-03-31", "2016-03-31", "2019-03-31", "2020-03-31", "2021-03-31", "2022-03-31", "2023-03-31", "2024-03-31", "2025-03-31", "2026-03-31"];
const sales = [141, 106, 35, 25, 13, 1132, 1362, 1554, 1653, 1952];
const brk = businessBreak(dates, sales);
assert.deepEqual(brk, { date: "2022-03-31", from: 13, to: 1132 });
const c = cagrCheck("sales", "Sales growth", dates, sales, { businessBreak: brk });
assert.equal(c.verdict, "na");
assert.match(c.note!, /Not comparable: business changed FY2022/);
// ROCE only after the change; 4 years → the 3-year average (34 + 28 + 21) / 3.
const r = roceAverage({ dates, roce: [null, 1, null, -109, -406, null, 36, 34, 28, 21] }, brk);
assert.equal(r!.years, 3);
assert.ok(Math.abs(r!.avg - 83 / 3) < 1e-9);
// Ordinary growth is not a business change.
assert.equal(businessBreak(dates, [10, 12, 15, 20, 30, 45, 70, 100, 150, 200]), null);

// Book value per share keeps loss years (VIP FY2025–26).
const bv = bookValuePerShare(
  { dates: ["2024-03-31", "2025-03-31", "2026-03-31"], pat: [54, -69, -338], eps: [3.83, -4.84, -23.79] },
  { dates: ["2024-03-31", "2025-03-31", "2026-03-31"], book_value: [1000, 930, 600], equity_capital: [28, 28, 28] },
);
assert.ok(bv!.every((v) => v != null), JSON.stringify(bv));
// Profit near zero: shares carried from the nearest year by equity capital.
const bv2 = bookValuePerShare(
  { dates: ["2025-03-31", "2026-03-31"], pat: [100, 0], eps: [10, 0] },
  { dates: ["2025-03-31", "2026-03-31"], book_value: [500, 1000], equity_capital: [10, 20] },
);
assert.deepEqual(bv2, [50, 50]);

// Peer median never includes the stock itself; needs 3 others.
const ports = [{ t: "ADANIPORTS", v: 4.61 }, { t: "JSWINFRA", v: 7.53 }, { t: "GPPL", v: 3.54 }];
assert.equal(peerMedian(ports, "ADANIPORTS"), null);
const four = [...ports, { t: "X", v: 2 }];
assert.deepEqual(peerMedian(four, "ADANIPORTS"), { m: 3.54, n: 3 });

// Screener peer table without P/B / P/S columns (account settings).
assert.equal(peersTableLacksColumns('<table><tr><th>CMP Rs.</th><th>P/E</th></tr><tr data-row-company-id="1"><td><a href="/company/X/">X</a></td></tr></table>'), true);
assert.equal(peersTableLacksColumns('<table><tr><th>CMP / BV</th></tr><tr data-row-company-id="1"><td><a href="/company/X/">X</a></td></tr></table>'), false);

console.log("portfolio-review-rules ok");
