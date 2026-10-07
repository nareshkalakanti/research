import assert from "node:assert/strict";
import {
  VP_MIN_POSTS,
  calculateActivitySignal,
  calculateMentionMomentum,
  calculateNewContributors,
  calculatePersistence,
  countInWindow,
  monthlyMentionBars,
  percentileRanks,
  priorWindowCount,
  uniqueAuthors,
  type VpPost,
} from "../src/lib/valuepickr-signal-engine";
import { calculateThemeStrength, tagPostTone } from "../src/lib/valuepickr-themes";

const asOf = new Date("2026-06-15T00:00:00Z");

function p(
  id: string,
  company: string | null,
  author: string,
  at: string | null,
): VpPost {
  return {
    post_id: id,
    company_id: company,
    author_id: author,
    posted_at: at,
  };
}

assert.deepEqual(percentileRanks([]), []);
assert.deepEqual(percentileRanks([3]), [1]);
const pr = percentileRanks([1, 2, 2, 4]);
assert.equal(pr[0], 0);
assert.ok(Math.abs(pr[1]! - pr[2]!) < 1e-12);
assert.equal(pr[3], 1);

const none: VpPost[] = [];
assert.equal(countInWindow(none, asOf, 30), 0);
assert.equal(uniqueAuthors(none), 0);

const one = [p("1", "AAA", "a", "2026-06-10T00:00:00Z")];
assert.equal(countInWindow(one, asOf, 30), 1);
assert.equal(uniqueAuthors(one), 1);

const miss = [p("1", "AAA", "a", null), p("2", "AAA", "b", "not-a-date")];
assert.equal(countInWindow(miss, asOf, 30), 0);

const dupAuthors = [
  p("1", "AAA", "a", "2026-06-01T00:00:00Z"),
  p("2", "AAA", "a", "2026-06-02T00:00:00Z"),
  p("3", "AAA", "a", "2026-06-03T00:00:00Z"),
];
assert.equal(uniqueAuthors(dupAuthors), 1);

const many = [
  p("1", "AAA", "a", "2026-06-01T00:00:00Z"),
  p("2", "AAA", "b", "2026-06-02T00:00:00Z"),
];
assert.equal(uniqueAuthors(many), 2);

assert.deepEqual(calculateMentionMomentum({ current: 0, previous: 0 }).label, "NO ACTIVITY");
assert.deepEqual(calculateMentionMomentum({ current: 5, previous: 0 }).label, "NEW ACTIVITY");
assert.equal(calculateMentionMomentum({ current: 47, previous: 19 }).pct, ((47 - 19) / 19) * 100);

const win = priorWindowCount(
  [
    p("1", "AAA", "a", "2026-06-10T00:00:00Z"),
    p("2", "AAA", "a", "2026-05-10T00:00:00Z"),
  ],
  asOf,
  30,
);
assert.equal(win.current, 1);
assert.equal(win.previous, 1);

const firstNew = calculateNewContributors(
  [
    p("1", "AAA", "old", "2025-01-01T00:00:00Z"),
    p("2", "AAA", "new", "2026-06-01T00:00:00Z"),
  ],
  asOf,
  30,
);
assert.equal(firstNew, 1);

const pers = calculatePersistence(
  [
    p("1", "AAA", "a", "2026-01-15T00:00:00Z"),
    p("2", "AAA", "a", "2026-02-15T00:00:00Z"),
    p("3", "AAA", "a", "2026-04-15T00:00:00Z"),
  ],
  asOf,
);
assert.equal(pers.active_months_all, 3);
assert.ok(pers.months.includes("2026-01"));
assert.ok(!pers.months.includes("2026-03"));

const by = new Map<string, VpPost[]>();
by.set("NEW", [p("1", "NEW", "a", "2026-06-01T00:00:00Z")]);
by.set(
  "RICH",
  Array.from({ length: 8 }, (_, i) =>
    p(
      `r${i}`,
      "RICH",
      `u${i % 4}`,
      `2026-0${(i % 5) + 1}-10T00:00:00Z`,
    ),
  ),
);
const conf = new Map<string, number | null>([
  ["NEW", 0.9],
  ["RICH", 0.9],
]);
const rows = calculateActivitySignal(by, asOf, conf);
const neu = rows.find((r) => r.company_id === "NEW")!;
assert.equal(neu.signal_label, "INSUFFICIENT DATA");
assert.equal(neu.signal, null);
assert.ok(neu.quality.posts < VP_MIN_POSTS || neu.quality.grade === "INSUFFICIENT DATA");

const rich = rows.find((r) => r.company_id === "RICH")!;
assert.ok(rich.signal == null || Number.isInteger(rich.signal));

const again = calculateActivitySignal(by, asOf, conf);
assert.deepEqual(
  again.map((r) => r.signal),
  rows.map((r) => r.signal),
);

const unmapped = new Map<string, VpPost[]>();
const emptySig = calculateActivitySignal(unmapped, asOf, new Map());
assert.equal(emptySig.length, 0);

assert.equal(tagPostTone("Is this cheap?"), "q");
assert.equal(tagPostTone("strong recovery in growth"), "pos");
assert.equal(tagPostTone("weak demand and miss"), "neg");

const th = calculateThemeStrength(["order book expanding", "capex announced"]);
assert.ok(th.some((t) => t.theme === "Order Book"));
assert.ok(th.some((t) => t.theme === "Capex"));
assert.ok(th.every((t) => t.posts > 0));

const bars = monthlyMentionBars(
  [
    p("1", "AAA", "a", "2026-05-01T00:00:00Z"),
    p("2", "AAA", "a", "2026-06-01T00:00:00Z"),
  ],
  asOf,
  () => "neu",
);
assert.ok(bars.length >= 2);
assert.equal(bars[0]?.month, "2026-05");

console.log("valuepickr-signal-engine ok");
