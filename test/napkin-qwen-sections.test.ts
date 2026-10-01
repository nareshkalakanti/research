import assert from "node:assert/strict";
import { NAPKIN_QWEN_SYSTEM } from "../src/lib/napkin/qwen-prompt";
import { groupQwenSections, parseQwenBaseCagr } from "../src/lib/napkin/qwen-sections";

for (const h of [
  "## GROWTH DRIVERS",
  "## MANAGEMENT TRACK RECORD",
  "## RISKS",
  "## BEAR CASE",
  "## BASE CASE",
  "## BULL CASE",
  "## NAPKIN ASSESSMENT",
]) {
  assert.ok(NAPKIN_QWEN_SYSTEM.includes(h), h);
}

const groups = groupQwenSections([
  { heading: "Growth Drivers", body: "capacity" },
  { heading: "RISKS", body: "fx" },
  { heading: "BEAR CASE", body: "low" },
  { heading: "BASE CASE", body: "mid" },
  { heading: "BULL CASE", body: "high" },
  { heading: "NAPKIN ASSESSMENT", body: "gap" },
]);
assert.deepEqual(
  groups.map((g) => g.title),
  [
    "Growth Drivers",
    "Risks",
    "Bear / Base / Bull",
    "Napkin Assessment",
  ],
);
assert.equal(groups[2]!.items.length, 3);
assert.equal(parseQwenBaseCagr("Base EPS CAGR 22% over five years."), 0.22);
assert.equal(parseQwenBaseCagr("Not available"), null);
console.log("napkin-qwen-sections ok");
