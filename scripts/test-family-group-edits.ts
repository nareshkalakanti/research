/**
 *   npm run test:family-group-edits
 */
import assert from "node:assert/strict";
import {
  applyLoadedFamilyGroupEdits,
  type FamilyGroupEdit,
} from "../src/lib/family-group-edits";

type Co = { ticker: string };
type Gr = {
  family_name: string;
  company_count: number;
  companies: Co[];
  group_id?: string;
};

const resolve = (t: string): Co => ({ ticker: t });

const house: FamilyGroupEdit = {
  group_id: "house-a",
  label: "Alpha House",
  add: ["SHARECO"],
  remove: [],
  updated_at: "2026-10-01T12:00:00.000Z",
};
const older: FamilyGroupEdit = {
  group_id: "user-older",
  label: "Beta House",
  add: ["SHARECO", "OWNCO"],
  remove: [],
  updated_at: "2026-09-01T00:00:00.000Z",
};
const edits = new Map([
  [house.group_id, house],
  [older.group_id, older],
]);

const groups: Gr[] = [
  {
    family_name: "Alpha House",
    company_count: 2,
    companies: [{ ticker: "ONE" }, { ticker: "TWO" }],
    group_id: "house-a",
  },
];
applyLoadedFamilyGroupEdits(groups, edits, resolve);
const alpha = groups.find((g) => g.group_id === "house-a")!;
const beta = groups.find((g) => g.group_id === "user-older")!;
assert.ok(alpha.companies.some((c) => c.ticker === "SHARECO"));
assert.ok(beta.companies.some((c) => c.ticker === "SHARECO"));
assert.ok(beta.companies.some((c) => c.ticker === "OWNCO"));

console.log("test:family-group-edits: ok");
