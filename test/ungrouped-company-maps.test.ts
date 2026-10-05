/**
 * Ungrouped cards are 1 listed company not in a 2+ house, with outside boards.
 */
import assert from "node:assert/strict";
import {
  loadGovernanceFamilyMap,
  loadUngroupedCompanyMaps,
} from "../src/lib/governance-map";

const houses = loadGovernanceFamilyMap({ refresh: true });
const grouped = new Set(
  houses
    .filter((g) => g.companies.length >= 2)
    .flatMap((g) => g.companies.map((c) => c.ticker.toUpperCase())),
);

const solos = loadUngroupedCompanyMaps();
assert.ok(solos.length >= 1, "need at least one ungrouped company with outside boards");
for (const g of solos) {
  assert.equal(g.company_count, 1, g.family_name);
  assert.equal(g.companies.length, 1, g.family_name);
  const hub = g.companies[0]!.ticker.toUpperCase();
  assert.equal(grouped.has(hub), false, hub);
  assert.ok((g.outside?.length ?? 0) >= 1, hub);
  assert.equal(
    (g.outside ?? []).some((o) => o.ticker.toUpperCase() === hub),
    false,
    hub,
  );
}
