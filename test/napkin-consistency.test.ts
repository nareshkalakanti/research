import assert from "node:assert/strict";
import { latestAnnualEpsPat, pickCurrentEps } from "../src/lib/napkin/current-eps";
import { isLender, napkinPerformance } from "../src/lib/napkin/performance";
import { bookValuePerShare, roceAverage } from "../src/lib/napkin/quality-flags";

const now = Date.UTC(2026, 10, 24);
const qd = ["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"];

// 1. Quarter EPS sum wins.
let p = pickCurrentEps({ quarters: qd.map((date) => ({ date, eps: 15, netIncome: 20_000 })), annualEps: 59.69, annualPat: 95_000, now });
assert.deepEqual([p.eps, p.source], [60, "screener_quarters"]);

// 2. No quarterly EPS (NSE source): profit ÷ shares implied by the annual report
//    (Reliance: total profit includes minority interest, so ÷ PAT/EPS cancels it).
p = pickCurrentEps({ quarters: qd.map((date) => ({ date, netIncome: 23_900 })), annualEps: 59.69, annualPat: 95_000, now });
assert.equal(p.source, "quarter_profit");
assert.ok(Math.abs(p.eps! - 60.07) < 0.05, String(p.eps));

// Quarter EPS 2× the profit-based figure (bonus not adjusted) → profit-based.
p = pickCurrentEps({ quarters: qd.map((date) => ({ date, eps: 30, netIncome: 20_000 })), annualEps: 59.69, annualPat: 95_000, now });
assert.equal(p.source, "quarter_profit");

// Rupee quarterly profit converts.
p = pickCurrentEps({ quarters: qd.map((date) => ({ date, revenue: 2e11, netIncome: 239e9 })), annualEps: 59.69, annualPat: 95_000, now });
assert.ok(Math.abs(p.eps! - 60.07) < 0.05, String(p.eps));

// 3. Yahoo only when it agrees with the annual report (VBL: 2.89 vs 8.98).
p = pickCurrentEps({ quarters: [], annualEps: 8.98, annualPat: null, yahooTtm: 2.89, now });
assert.deepEqual([p.eps, p.source, p.rejected_yahoo], [8.98, "annual", 2.89]);
p = pickCurrentEps({ quarters: [], annualEps: 57.14, annualPat: null, yahooTtm: 79.23, now });
assert.deepEqual([p.eps, p.source], [79.23, "yahoo_ttm"]);

// Old quarters (> 300 days) are not a trailing year.
p = pickCurrentEps({ quarters: ["2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30"].map((date) => ({ date, eps: 1 })), annualEps: 5, annualPat: null, now });
assert.equal(p.source, "annual");

assert.deepEqual(latestAnnualEpsPat({ dates: ["2025-03-31", "2026-03-31"], eps: [10, null], pat: [100, 120] }), { eps: 10, pat: 100 });

// Lenders: D/E, ROCE, EBITDA margin not scored.
assert.equal(isLender("Private Banks"), true);
assert.equal(isLender("NBFC Others"), true);
assert.equal(isLender("Finance Housing"), true);
assert.equal(isLender("Textiles Spinning and Cotton and Blended"), false);
assert.equal(isLender("Finance Insurance"), false);
assert.equal(isLender(null, "Banks - Regional"), true);
const perf = napkinPerformance({ revenue_cagr_5y: 0.2, ebitda_margin: null, roce: 0.07, debt_equity: 0.8, lender: true });
assert.deepEqual(perf.checks.map((c) => c.verdict), ["pass", "na", "na", "na"]);
assert.equal(perf.scored, 1);

// Shared ROCE rule: 10-yr average, pass above 10%.
const yrs = Array.from({ length: 10 }, (_, i) => `${2017 + i}-03-31`);
const r = roceAverage({ dates: yrs, roce: [10, 10, 10, 10, 10, 10, 10, 10, 10, 9] });
assert.equal(r!.years, 10);
assert.ok(Math.abs(r!.avg - 9.9) < 1e-9);

// Book value per share: shares for each year = that year's PAT ÷ EPS.
const bvps = bookValuePerShare(
  { dates: ["2024-03-31", "2025-03-31"], pat: [100, 100], eps: [10, 5] },
  { dates: ["2024-03-31", "2025-03-31"], book_value: [1000, 1100] },
);
assert.deepEqual(bvps, [100, 55]);

console.log("napkin-consistency ok");
