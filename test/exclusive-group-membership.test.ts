import assert from "node:assert/strict";
import { exclusiveGroupMembership } from "../src/lib/governance-map";

type G = {
  family_name: string;
  group_id?: string;
  companies: Array<{ ticker: string }>;
  company_count: number;
};

const g = (name: string, id: string, tickers: string[]): G => ({
  family_name: name,
  group_id: id,
  companies: tickers.map((ticker) => ({ ticker })),
  company_count: tickers.length,
});

const a = g("House A", "user-a", ["AAA", "BBB", "SHARED"]);
const b = g("House B", "b", ["CCC", "SHARED"]);
exclusiveGroupMembership([a, b], {
  addedByGroupId: new Map([["user-a", new Set(["SHARED"])]]),
  rank: (ticker, group) =>
    group.group_id === "user-a" && ticker === "SHARED" ? 2 : 1,
});
assert.deepEqual(
  a.companies.map((c) => c.ticker),
  ["AAA", "BBB", "SHARED"],
);
assert.deepEqual(
  b.companies.map((c) => c.ticker),
  ["CCC"],
);

const sp = g("House SP", "user-sp", ["AFCONS", "JVCO"]);
const ster = g("Sterling", "ot", ["TOOL", "JVCO"]);
exclusiveGroupMembership([sp, ster], {
  addedByGroupId: new Map([["user-sp", new Set(["JVCO"])]]),
  rank: (ticker, group) => (group.group_id === "user-sp" ? 5 : 1),
  companyName: (ticker) =>
    ticker === "JVCO" ? "Sterling and Wilson Renewable Energy Limited" : "",
});
assert.equal(
  sp.companies.some((c) => c.ticker === "JVCO"),
  true,
);
assert.equal(
  ster.companies.some((c) => c.ticker === "JVCO"),
  true,
);

console.log("exclusive-group-membership: ok");
