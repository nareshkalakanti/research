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
import { auditAllThemes, loadAboutRows } from "../src/lib/theme-audit";

function main() {
  const file = loadThemes();
  assert.equal(file.themes.length, 19, `expected 19 themes, got ${file.themes.length}`);
  const groups = groupThemesByBlog(file.themes);
  assert.equal(groups.length, 3, `expected 3 blog groups, got ${groups.length}`);
  assert.ok(groups.some((g) => g.blog_theme === "Niveshaay Deep Dives"));
  assert.ok(groups.some((g) => g.blog_theme === "Global High Demand Themes"));
  assert.ok(groups.some((g) => g.blog_theme === "US Market Momentum 2026"));

  const required = [
    "pharma_medicine_factory",
    "electronics_value_chain",
    "private_space",
    "ai_compute_datacenter",
    "defence_aerospace",
    "memory_dram_hbm",
    "copper_value_chain",
    "peb_steel_structures",
    "global_copper_electrification",
    "global_power_transformer_bottleneck",
    "global_critical_war_metals",
    "global_hbm_advanced_packaging",
    "global_liquid_cooling_thermal",
    "global_rare_earth",
    "us_nuclear_baseload_ai",
    "us_space_direct_to_cell",
    "us_glp1_second_order",
    "us_defense_autonomous_swarm",
    "us_tokenization_private_credit",
  ];
  for (const id of required) {
    assert.ok(
      file.themes.some((t) => t.id === id),
      `missing theme ${id}`,
    );
  }

  const filters = loadThemeSectorFilters();
  assert.equal(Object.keys(filters).length, 19, "sector filters should cover all themes");
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

  const globalCopper = themesByIds(["global_copper_electrification"])[0]!;
  assert.ok(
    themeMatch(busBarBlurb, globalCopper, filters),
    "bus bars must match global_copper_electrification",
  );

  const hbm = themesByIds(["global_hbm_advanced_packaging"])[0]!;
  const sahasra = {
    about:
      "semiconductor packaging and electronic manufacturing services for global OEMs",
    search_text:
      "semiconductor packaging electronic manufacturing services OSAT EMS",
    sector: "IT & Technology",
    sub_sector: "Electronic Equipments",
  };
  assert.ok(
    themeMatch(sahasra, hbm, filters),
    "SAHASRA-style packaging blurb must match global_hbm_advanced_packaging",
  );

  const liquid = themesByIds(["global_liquid_cooling_thermal"])[0]!;
  const blueStar = {
    about:
      "scroll and screw chillers, centrifugal chillers, and data center chillers for commercial refrigeration",
    search_text:
      "scroll chillers centrifugal chillers data center chillers commercial refrigeration",
    sector: "Consumer Durables",
    sub_sector: "Home Electronics & Appliances",
  };
  assert.ok(
    themeMatch(blueStar, liquid, filters),
    "Blue Star-style chiller blurb must match global_liquid_cooling_thermal",
  );

  const autoThermal = {
    about: "develops thermal management systems for combustion engines and two wheelers",
    search_text: "thermal management combustion engines two wheeler",
    sector: "Automobile & Ancillaries",
    sub_sector: "Auto Parts",
  };
  assert.ok(
    !themeMatch(autoThermal, liquid, filters),
    "auto thermal management must not match liquid cooling theme",
  );

  const rareEarth = themesByIds(["global_rare_earth"])[0]!;
  const midwest = {
    about:
      "heavy mineral sand products such as rutile, ilmenite, zircon, garnet, monazite, and sillimanite",
    search_text:
      "heavy mineral sand rutile ilmenite zircon garnet monazite sillimanite",
    sector: "Basic Materials",
    sub_sector: "Building Materials",
  };
  assert.ok(
    themeMatch(midwest, rareEarth, filters),
    "Midwest monazite blurb must match global_rare_earth",
  );
  const ceriumAlloy = {
    about: "provides barium, calcium, cerium, strontium ferro silicon magnesium alloys",
    search_text: "barium calcium cerium strontium ferro silicon magnesium",
    sector: "Metals & Mining",
    sub_sector: "Metals - Diversified",
  };
  assert.ok(
    !themeMatch(ceriumAlloy, rareEarth, filters),
    "cerium in alloy list must not match global_rare_earth",
  );
  const gmdcObservatory = {
    about:
      "mining and mineral processing. strategic collaboration for an AI-powered rare earth supply chain observatory and a platform that tracks the rare earth elements value chain.",
    search_text:
      "mining mineral processing rare earth supply chain observatory rare earth elements value chain",
    sector: "Metals & Mining",
    sub_sector: "Mining - Diversified",
  };
  assert.ok(
    themeMatch(gmdcObservatory, rareEarth, filters),
    "GMDC REE observatory blurb must match global_rare_earth",
  );
  assert.ok(
    !rareEarth.keywords.includes("rare earth + mining"),
    "removed loose rare earth + mining keyword (GMDC false positive)",
  );
  assert.ok(
    patternMatches(gmdcObservatory.search_text, "rare earth + value chain"),
    "GMDC observatory must match rare earth + value chain",
  );
  const deltaMagnet = {
    about:
      "low energy embedding powder magnets for bonded applications; and rare earth magnets for electric vehicle drive motors",
    search_text:
      "bonded applications rare earth magnets electric vehicle drive motors",
    sector: "Engineering & Capital Goods",
    sub_sector: "Industrial Machinery",
  };
  assert.ok(
    themeMatch(deltaMagnet, rareEarth, filters),
    "Delta bonded REE magnet blurb must match global_rare_earth",
  );
  assert.ok(
    patternMatches(deltaMagnet.search_text, "bonded + rare earth"),
    "Delta must match bonded + rare earth keyword",
  );

  const nuclear = themesByIds(["us_nuclear_baseload_ai"])[0]!;
  const ippBlurb = {
    about:
      "operates as an independent power producer that focuses on the development, construction, ownership and operation of solar power plants",
    search_text:
      "independent power producer solar power plants development construction ownership operation",
    sector: "Power & Utilities",
    sub_sector: "Power Generation",
  };
  assert.ok(
    themeMatch(ippBlurb, nuclear, filters),
    "IPP solar blurb must match us_nuclear_baseload_ai",
  );
  assert.ok(
    !nuclear.keywords.includes("SMR"),
    "SMR removed — matches jewellery ticker SMR not reactors",
  );

  const glp1 = themesByIds(["us_glp1_second_order"])[0]!;
  const emcureBlurb = {
    about:
      "development and commercialization of Poviztra, a semaglutide injection for weight loss",
    search_text: "semaglutide injection for weight loss Poviztra",
    sector: "Pharmaceuticals",
    sub_sector: "Pharmaceuticals - Formulations",
  };
  assert.ok(
    themeMatch(emcureBlurb, glp1, filters),
    "Emcure semaglutide blurb must match us_glp1_second_order",
  );

  const rwa = themesByIds(["us_tokenization_private_credit"])[0]!;
  const fintechBlurb = {
    about: "provides blockchain based solutions and fintech platforms for capital markets",
    search_text: "blockchain based solutions fintech platforms capital markets",
    sector: "IT & Technology",
    sub_sector: "IT Services & Consulting",
  };
  assert.ok(
    themeMatch(fintechBlurb, rwa, filters),
    "blockchain fintech blurb must match us_tokenization_private_credit",
  );

  const ems = themesByIds(["electronics_value_chain"])[0]!;
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

  const rows = loadAboutRows();
  const audits = auditAllThemes(file.themes, rows);
  assert.equal(audits.length, 19, "audit should cover all themes");

  for (const a of audits) {
    assert.ok(a.gatedMatches > 0, `${a.id} must have at least one gated match`);
    const hitting = a.keywords.filter((k) => k.hits > 0);
    assert.ok(
      hitting.length > 0,
      `${a.id} must have at least one keyword with About hits`,
    );
    assert.equal(
      a.zeroHit.length,
      0,
      `${a.id} has zero-hit keywords: ${a.zeroHit.join(", ")}`,
    );
  }

  const zeroByTheme = audits
    .filter((a) => a.zeroHit.length > 0)
    .map((a) => `${a.id}(${a.zeroHit.length})`);
  const looseByTheme = audits
    .filter((a) => a.looseAndTickers.length > 0)
    .map((a) => `${a.id}:${a.looseAndTickers.slice(0, 4).join(",")}`);

  console.log("✓ themes loaded", file.themes.length, "in", groups.length, "groups");
  console.log("✓ sector filters", Object.keys(filters).length);
  console.log("✓ defence gate / copper exclude / PCB allow");
  console.log("✓ keyword highlights", hits.slice(0, 4));
  console.log("✓ corpus audit", rows.length, "companies · all themes have hits + gated matches · no zero-hit keywords");
  if (looseByTheme.length) {
    console.log("  loose AND flags:", looseByTheme.join(" · "));
  }
  console.log("\nAll theme checks passed.");
}

main();
