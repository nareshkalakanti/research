import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const file = path.join(
  process.cwd(),
  "src/components/ValuePickrSignalsPanel.tsx",
);
const src = fs.readFileSync(file, "utf8");

const banned = [
  "Sukhjit",
  "Cords Cable",
  "Atam Valves",
  "SUKHJITS",
  "CORDSCABLE",
  "multibagger",
  "Buy Signal",
  "AI Score",
  "84% correct",
  "Elite investor",
  "654 calls",
];
for (const w of banned) {
  assert.equal(src.includes(w), false, `frontend must not contain ${w}`);
}

assert.equal(/\b998\b/.test(src), false);
assert.equal(src.includes("Math.random"), false);
assert.equal(src.includes("mockData"), false);
assert.equal(src.includes("dummyData"), false);
assert.equal(src.includes("fakeData"), false);

console.log("valuepickr-no-hardcoded-frontend ok");
