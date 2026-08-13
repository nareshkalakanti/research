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
  assert.equal(file.themes.length, 20, `expected 20 themes, got ${file.themes.length}`);
  const groups = groupThemesByBlog(file.themes);
  assert.equal(groups.length, 3, `expected 3 blog groups, got ${groups.length}`);
  assert.ok(groups.some((g) => g.blog_theme === "Niveshaay Deep Dives"));
  assert.ok(groups.some((g) => g.blog_theme === "Nanocap Champs"));
  assert.ok(groups.some((g) => g.blog_theme === "Listed Venture Capital"));

  const required = [
    "pharma_medicine_factory",
    "electronics_value_chain",
    "private_space",
    "ai_compute_datacenter",
    "defence_aerospace",
    "memory_dram_hbm",
    "copper_value_chain",
    "peb_steel_structures",
    "solar_clean_energy",
    "flexible_packaging",
    "food_processing",
    "micro_irrigation",
    "oil_gas_geophysical",
    "hospitals_healthcare",
    "realty_redevelopment",
    "foundry_casting",
    "jewellery_lgd_export",
    "steel_tmt_coated",
    "auto_fasteners",
    "specialty_pib_chemicals",
  ];
  for (const id of required) {
    assert.ok(
      file.themes.some((t) => t.id === id),
      `missing theme ${id}`,
    );
  }

  const filters = loadThemeSectorFilters();
  assert.equal(Object.keys(filters).length, 20, "sector filters should cover all themes");
  assert.ok(filters.copper_value_chain, "sector filters missing copper_value_chain");

  const pharma = themesByIds(["pharma_medicine_factory"]);
  assert.equal(pharma.length, 1);
  const pharmaPattern = combinePatterns(pharma.map((t) => t.display_pattern));
  assert.ok(
    patternMatches(
      "We are a leading CDMO and API intermediates manufacturer",
      pharmaPattern,
    ),
  );
  assert.ok(
    !patternMatches("We provide gold loan and NBFC services only", pharmaPattern),
    "CDMO should not match NBFC blurb",
  );

  const defence = themesByIds(["defence_aerospace"])[0]!;
  const hospital = {
    about:
      "multispecialty hospital offering neurosciences, nuclear medicine and PET CT, obstetrics",
    search_text:
      "kovai medical hospital healthcare services nuclear medicine PET CT",
    sector: "Pharmaceuticals & Healthcare",
    sub_sector: "Hospitals & Diagnostic Centres",
  };
  assert.ok(
    !themeMatch(hospital, defence, filters),
    "hospital must not match defence_aerospace",
  );

  const realDefence = {
    about: "manufactures missile subsystems and unmanned aerial vehicles for defence",
    search_text: "missile drone unmanned aerial defence aerospace",
    sector: "Engineering & Capital Goods",
    sub_sector: "Aerospace & Defense",
  };
  assert.ok(
    themeMatch(realDefence, defence, filters),
    "defence supplier should match defence_aerospace",
  );

  assert.ok(
    !sectorGatePasses(
      {
        sector: "Retail",
        sub_sector: "Precious Metals, Jewellery & Watches",
      },
      filters.copper_value_chain,
    ),
    "jewellery pair excluded from copper",
  );

  const copper = themesByIds(["copper_value_chain"])[0]!;
  const busBarBlurb = {
    about:
      "distributes copper flats/bus bars, wires and rods, foils and sheets in India",
    search_text:
      "distributes copper flats/bus bars, wires and rods, foils and sheets in India",
    sector: "Metals & Mining",
    sub_sector: "Metals - Copper",
  };
  assert.ok(
    themeMatch(busBarBlurb, copper, filters),
    "bus bars (two words) must match copper_value_chain",
  );
  assert.ok(
    !themeMatch(
      {
        about: "AI-led digital transformation serves manufacturing clients",
        search_text: "AI-led digital transformation serves manufacturing clients",
        sector: "Retail",
        sub_sector: "Speciality Retail",
      },
      copper,
      filters,
    ),
    "non-copper sector must not match copper theme",
  );

  const ems = themesByIds(["electronics_value_chain"])[0]!;
  const aiLedBlurb = {
    about: "AI-led digital transformation serves manufacturing clients with IT solutions",
    search_text: "ai led digital transformation manufacturing it solutions",
    sector: "IT & Technology",
    sub_sector: "IT Services & Consulting",
  };
  assert.ok(
    !themeMatch(aiLedBlurb, ems, filters),
    "AI-led + manufacturing must not match electronics_value_chain",
  );

  const pcbBlurb = {
    about: "printed circuit boards and multilayer laminates for consumer electronics",
    search_text:
      "printed circuit boards and multilayer laminates for consumer electronics",
    sector: "Engineering & Capital Goods",
    sub_sector: "Electronic Equipments",
  };
  assert.ok(
    themeMatch(pcbBlurb, ems, filters),
    "real PCB fab should match electronics_value_chain",
  );

  const hits = matchedKeywords(
    "Contract manufacturing of pharmaceutical formulations and injectables under WHO-GMP",
    pharmaPattern,
  );
  assert.ok(hits.length > 0, "expected keyword hits");

  console.log("✓ themes loaded", file.themes.length, "in", groups.length, "groups");
  console.log("✓ sector filters", Object.keys(filters).length);
  console.log("✓ defence gate / copper exclude / PCB allow");
  console.log("✓ keyword highlights", hits.slice(0, 4));
  console.log("\nAll theme checks passed.");
}

main();
