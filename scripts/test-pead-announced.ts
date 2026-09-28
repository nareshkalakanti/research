/**
 * PEAD 2 announcement-date helpers (no issuer facts).
 * Run: npx tsx scripts/test-pead-announced.ts
 */
import assert from "node:assert/strict";
import {
  isCalendarQuarterEnd,
  isPeadResultAnnouncement,
  latestAnnounceOnOrBefore,
  quarterHasAnnouncement,
  sliceToAnnouncedQuarters,
} from "../src/lib/pead-announced";
import { peadScoreFf, usableForwardPe } from "../src/lib/pead-score";
import { parseGrowwTtmValuation } from "../src/lib/groww-quarters";
import type { QuarterPoint } from "../src/lib/quarter-panel";

function q(date: string): QuarterPoint {
  return {
    date,
    revenue: 1,
    netIncome: 1,
    eps: 1,
    ebit: 1,
  };
}

assert.equal(isCalendarQuarterEnd("2026-06-30"), true);
assert.equal(isCalendarQuarterEnd("2026-09-25"), false);
assert.equal(isCalendarQuarterEnd("2026-03-31"), true);

assert.equal(
  isPeadResultAnnouncement("Clarification - Financial Results", ""),
  false,
);
assert.equal(
  isPeadResultAnnouncement("Reply to Clarification- Financial results", ""),
  false,
);
assert.equal(
  isPeadResultAnnouncement(
    "General Updates",
    "September 26, 2026 The General Manager Corporate Relations Department BSE Limited financial",
  ),
  false,
);
assert.equal(
  isPeadResultAnnouncement("Financial Results", "Unaudited financial results"),
  true,
);
assert.equal(
  isPeadResultAnnouncement(
    "Outcome of Board Meeting",
    "Audited financial results for the period ended June 30, 2026",
  ),
  true,
);
assert.equal(
  isPeadResultAnnouncement("Outcome of Board Meeting", "Appointment of director"),
  false,
);

assert.equal(
  latestAnnounceOnOrBefore(["2026-09-25", "2026-07-27"], "2026-09-28"),
  "2026-09-25",
);

assert.equal(
  quarterHasAnnouncement("2026-06-30", ["2026-09-02"], "2026-09-28"),
  true,
);
assert.equal(
  quarterHasAnnouncement("2026-09-30", ["2026-09-02"], "2026-09-28"),
  false,
);

const sliced = sliceToAnnouncedQuarters(
  [q("2026-03-31"), q("2026-06-30"), q("2026-09-30")],
  ["2026-09-02"],
  "2026-09-28",
);
assert.equal(sliced.at(-1)?.date, "2026-06-30");

assert.equal(usableForwardPe(999), null);
assert.equal(usableForwardPe(12), 12);
assert.equal(peadScoreFf(null, null, 10, -4, null, null, null), 3);

assert.deepEqual(
  parseGrowwTtmValuation({
    fundamentals: [
      { name: "P/E Ratio(TTM)", value: "18.82" },
      { name: "EPS(TTM)", value: "65.15" },
      { name: "Industry P/E", value: "15.90" },
    ],
  }),
  { pe_ttm: 18.82, eps_ttm: 65.15 },
);

console.log("pead-announced ok");
