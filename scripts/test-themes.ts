/**
 * Theme load + sector-gate match tests.
 * Run: npx tsx scripts/test-themes.ts
 */
import assert from "node:assert/strict";
import { loadThemes, groupThemesByBlog, themesByIds } from "../src/lib/themes";
import {
  combinePatterns,
  matchedKeywords,
  patternMatches,
} from "../src/lib/pattern";
import {
  loadThemeSectorFilters,
  sectorGatePasses,
  themeMatch,
} from "../src/lib/theme-match";

function main() {
  const file = loadThemes();
  assert.ok(file.themes.length >= 28, `expected themes, got ${file.themes.length}`);
  const groups = groupThemesByBlog(file.themes);
  assert.ok(groups.length >= 5, `expected groups, got ${groups.length}`);

  const required = [
    "pharma_cdmo",
    "electronics_ems",
    "packaging_materials",
    "hospitals_healthcare",
    "nuclear_renaissance",
    "nuclear_services_isotopes",
  ];
  for (const id of required) {
    assert.ok(
      file.themes.some((t) => t.id === id),
      `missing theme ${id}`,
    );
  }

  const filters = loadThemeSectorFilters();
  assert.ok(filters.copper_value_add, "sector filters missing copper_value_add");
  assert.ok(filters.nuclear_renaissance, "sector filters missing nuclear");

  const cdmo = themesByIds(["pharma_cdmo"]);
  assert.equal(cdmo.length, 1);
  const pattern = combinePatterns(cdmo.map((t) => t.display_pattern));
  assert.ok(
    patternMatches(
      "We are a leading CDMO and API intermediates manufacturer",
      pattern,
    ),
  );
  assert.ok(
    !patternMatches("We provide gold loan and NBFC services only", pattern),
    "CDMO should not match NBFC blurb",
  );

  const nuclear = themesByIds(["nuclear_renaissance"])[0]!;
  const hospital = {
    about:
      "multispecialty hospital offering neurosciences, nuclear medicine and PET CT, obstetrics",
    search_text:
      "kovai medical hospital healthcare services nuclear medicine PET CT",
    sector: "Pharmaceuticals & Healthcare",
    sub_sector: "Hospitals & Diagnostic Centres",
  };
  assert.ok(
    !themeMatch(hospital, nuclear, filters),
    "hospital nuclear medicine must not match nuclear_renaissance",
  );

  const services = themesByIds(["nuclear_services_isotopes"])[0]!;
  assert.ok(
    !themeMatch(hospital, services, filters),
    "hospital must not match nuclear_services",
  );

  const realNuclear = {
    about: "supplies nuclear grade valves and pumps to NPCIL nuclear power plants",
    search_text:
      "nuclear grade valves pumps NPCIL nuclear power industrial machinery",
    sector: "Engineering & Capital Goods",
    sub_sector: "Industrial Machinery",
  };
  assert.ok(
    themeMatch(realNuclear, nuclear, filters),
    "NPCIL industrial supplier should match",
  );

  assert.ok(
    !sectorGatePasses(
      {
        sector: "Retail",
        sub_sector: "Precious Metals, Jewellery & Watches",
      },
      filters.copper_value_add,
    ),
    "jewellery pair excluded from copper",
  );

  const hits = matchedKeywords(
    "Contract manufacturing of pharmaceutical formulations and injectables under WHO-GMP",
    pattern,
  );
  assert.ok(hits.length > 0, "expected keyword hits");

  console.log("✓ themes loaded", file.themes.length, "in", groups.length, "groups");
  console.log("✓ sector filters", Object.keys(filters).length);
  console.log("✓ hospital veto / NPCIL allow");
  console.log("✓ keyword highlights", hits.slice(0, 4));
  console.log("\nAll theme checks passed.");
}

main();
