/**
 * Concall drift quarter pill + announcement window.
 * Run: npx tsx scripts/test-concall-drift-quarters.ts
 */
import assert from "node:assert/strict";
import {
  currentEarnSeasonQuarter,
  earnAnnouncementWindowForFyQuarter,
  earnMatchesQuarterFilter,
  fyQuarterChipLabel,
  fyQuarterExplain,
  fyQuarterFromEarnEvent,
  fyQuarterReportingPeriod,
  isoDate,
} from "../src/lib/strategy/concall-drift-quarters";

function fmtCr(n: number): string {
  const rounded = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${rounded.toLocaleString("en-IN")} Cr`;
}

function main() {
  // Screenshot-style pill: Q1 FY27 (not "Apr–Jun '26")
  assert.equal(fyQuarterChipLabel("Q1FY27"), "Q1 FY27");
  assert.equal(fyQuarterChipLabel("Q4FY26"), "Q4 FY26");

  // Q1 FY27 = Apr–Jun 2026 results period
  const q1 = fyQuarterReportingPeriod("Q1FY27");
  assert.ok(q1);
  assert.equal(q1!.from.getFullYear(), 2026);
  assert.equal(q1!.from.getMonth(), 3); // Apr
  assert.equal(q1!.to.getMonth(), 5); // Jun

  // Filings for Q1 FY27 land ~ Jul–mid Oct 2026
  const win = earnAnnouncementWindowForFyQuarter("Q1FY27");
  assert.ok(win);
  assert.equal(isoDate(win!.from), "2026-07-01");
  assert.equal(isoDate(win!.to), "2026-10-15");

  // Meta bar style: Events · 2026-07-01 — 2026-10-15
  const meta = `Events · ${isoDate(win!.from)} — ${isoDate(win!.to)}`;
  assert.equal(meta, "Events · 2026-07-01 — 2026-10-15");

  // Earn filed in Jul 2026 for Jun quarter → Q1FY27
  assert.equal(
    fyQuarterFromEarnEvent(
      "2026-07-31T10:00:00+05:30",
      "Financial Results for the quarter ended 30 June 2026",
    ),
    "Q1FY27",
  );
  assert.equal(
    earnMatchesQuarterFilter(
      "2026-07-31T10:00:00+05:30",
      "Financial Results for the quarter ended 30 June 2026",
      "Q1FY27",
    ),
    true,
  );

  // MCap labels like screenshot (no 1.1L Cr)
  assert.equal(fmtCr(41), "41 Cr");
  assert.equal(fmtCr(11811), "11,811 Cr");
  assert.equal(fmtCr(110_000), "1,10,000 Cr");
  assert.ok(!fmtCr(110_000).includes("L"));

  const explain = fyQuarterExplain("Q1FY27");
  assert.ok(explain.includes("Apr–Jun 2026"));
  assert.ok(explain.includes("2026-07-01"));

  // Current season resolves to a QnFYnn key
  assert.match(currentEarnSeasonQuarter(), /^Q[1-4]FY\d{2}$/);

  console.log("ok · pill", fyQuarterChipLabel("Q1FY27"));
  console.log("ok · meta", meta);
  console.log("ok · mcap", `${fmtCr(41)} – ${fmtCr(110_000)}`);
  console.log("ok · tip ", explain);
}

main();
