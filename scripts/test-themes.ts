/**
 * Theme load + sector-gate match tests.
 * Run: npx tsx scripts/test-themes.ts
 */
import assert from "node:assert/strict";
import { loadThemes, groupThemesByBlog, themesByIds } from "../src/lib/themes";
import { matchedKeywords } from "../src/lib/pattern";
import {
  invalidateThemeSectorFilterCache,
  loadThemeSectorFilters,
  matchThemesForRow,
  themeMatch,
} from "../src/lib/theme-match";
import { auditTheme, loadAboutRows } from "../src/lib/theme-audit";
import { mergeAboutSourcesForSearch } from "../src/lib/db";

function main() {
  invalidateThemeSectorFilterCache();
  const file = loadThemes();
  assert.equal(file.themes.length, 24, `expected 24 themes, got ${file.themes.length}`);
  assert.ok(
    file.themes.some((t) => t.id === "india_repm_magnet_localization"),
    "REPM theme missing",
  );
  assert.ok(
    file.themes.some((t) => t.id === "gov_semicon_electronics_pli"),
    "gov semicon theme missing",
  );
  assert.ok(
    file.themes.some((t) => t.id === "gov_india_food_processing_pli"),
    "food processing PLI theme missing",
  );
  assert.ok(
    file.themes.some((t) => t.id === "gov_mumbai_redevelopment_realty"),
    "Mumbai redevelopment theme missing",
  );
  assert.ok(
    file.themes.some((t) => t.id === "gov_defence_aerospace_indigenisation"),
    "defence theme missing",
  );
  assert.ok(
    file.themes.some((t) => t.id === "gov_green_hydrogen_electrolyser"),
    "green hydrogen theme missing",
  );
  assert.ok(
    file.themes.some((t) => t.id === "gov_samudra_manthan_offshore_ep"),
    "Samudra Manthan theme missing",
  );
  assert.ok(
    file.themes.some((t) => t.id === "gov_mpms_mobile_manufacturing"),
    "MPMS mobile theme missing",
  );
  assert.ok(
    file.themes.some((t) => t.id === "gov_nuclear_power_shanti"),
    "nuclear theme missing",
  );

  const groups = groupThemesByBlog(file.themes);
  assert.equal(groups.length, 2, `expected 2 blog groups, got ${groups.length}`);

  const filters = loadThemeSectorFilters();
  assert.equal(
    Object.keys(filters).length,
    24,
    `expected 24 sector filters, got ${Object.keys(filters).length}`,
  );
  assert.ok(
    filters.india_repm_magnet_localization,
    "sector filter missing india_repm_magnet_localization",
  );
  assert.ok(
    filters.gov_solar_rooftop_renewable,
    "sector filter missing gov_solar_rooftop_renewable",
  );
  assert.ok(
    filters.gov_india_food_processing_pli,
    "sector filter missing gov_india_food_processing_pli",
  );
  assert.ok(
    filters.gov_mumbai_redevelopment_realty,
    "sector filter missing gov_mumbai_redevelopment_realty",
  );
  assert.ok(
    filters.gov_defence_aerospace_indigenisation,
    "sector filter missing defence",
  );
  assert.ok(
    filters.gov_samudra_manthan_offshore_ep,
    "sector filter missing Samudra Manthan",
  );

  const samudra = themesByIds(["gov_samudra_manthan_offshore_ep"]);
  const chemicalRow = {
    about:
      "manufactures chemicals and transformer oil for industrial markets",
    search_text:
      "manufactures chemicals transformer oil industrial copper acsr",
    sector: "Chemicals & Petrochemicals",
    sub_sector: "Commodity Chemicals",
  };
  assert.ok(
    !matchThemesForRow(chemicalRow, samudra, {
      customPattern: "acsr | copper | transformer oil",
    }).matched,
    "custom keywords must not bypass Samudra Manthan sector gate",
  );
  assert.ok(
    matchThemesForRow(chemicalRow, [], {
      customPattern: "acsr | copper | transformer oil",
    }).matched,
    "custom-only scan should still match chemicals",
  );
  const offshoreRow = {
    about: "offshore oil exploration and production of hydrocarbons",
    search_text: "offshore oil exploration production hydrocarbons",
    sector: "Oil & Gas & Energy",
    sub_sector: "Oil Exploration and Production",
  };
  assert.ok(
    matchThemesForRow(offshoreRow, samudra).matched,
    "true offshore E&P must match Samudra Manthan",
  );
  assert.ok(
    !matchThemesForRow(offshoreRow, samudra, {
      customPattern: "acsr | copper | transformer oil",
    }).matched,
    "theme + unrelated custom AND should exclude when custom misses",
  );

  assert.ok(
    filters.gov_mpms_mobile_manufacturing,
    "sector filter missing MPMS",
  );
  assert.ok(
    filters.gov_nuclear_power_shanti,
    "sector filter missing nuclear",
  );

  const repm = themesByIds(["india_repm_magnet_localization"])[0]!;
  assert.ok(
    themeMatch(
      {
        about:
          "designs, manufactures, and supplies traction motors for the automotive industry",
        search_text:
          "designs manufactures supplies traction motors automotive industry",
        sector: "Automobile & Ancillaries",
        sub_sector: "Auto Parts",
      },
      repm,
      filters,
    ),
    "traction motor OEM must match REPM theme",
  );

  assert.ok(
    !themeMatch(
      {
        about: "multispecialty hospital offering nuclear medicine and PET CT",
        search_text: "hospital healthcare nuclear medicine PET CT",
        sector: "Pharmaceuticals & Healthcare",
        sub_sector: "Hospitals & Diagnostic Centres",
      },
      repm,
      filters,
    ),
    "hospital must not match REPM theme",
  );

  const solar = themesByIds(["gov_solar_rooftop_renewable"])[0]!;
  assert.ok(
    themeMatch(
      {
        about: "provides rooftop solar EPC and photovoltaic modules",
        search_text: "rooftop solar EPC photovoltaic modules renewable",
        sector: "Power & Utilities",
        sub_sector: "Renewable Energy",
      },
      solar,
      filters,
    ),
    "rooftop solar EPC must match solar theme",
  );

  const mumbai = themesByIds(["gov_mumbai_redevelopment_realty"])[0]!;
  assert.ok(
    themeMatch(
      {
        about: "engaged in society redevelopment projects in Mumbai",
        search_text: "Mumbai society redevelopment projects realty developer",
        sector: "Real Estate & Construction",
        sub_sector: "Real Estate",
      },
      mumbai,
      filters,
    ),
    "Mumbai redevelopment must match",
  );
  assert.ok(
    !themeMatch(
      {
        about: "engaged in redevelopment projects across India",
        search_text: "redevelopment projects across India residential",
        sector: "Real Estate & Construction",
        sub_sector: "Real Estate",
      },
      mumbai,
      filters,
    ),
    "generic redevelopment without Mumbai must not match",
  );

  const hits = matchedKeywords(
    "manufactures and sells hard ferrites and soft ferrites with rare earth processing",
    repm.display_pattern,
  );
  assert.ok(hits.length > 0, "expected ferrite keyword hits");

  const merged = mergeAboutSourcesForSearch({
    about: null,
    yf_about: "Acme Ltd manufactures automotive components for OEMs.",
    scraped_about:
      "Acme Ltd also produces permanent magnet traction motors and BLDC motors for e-mobility.",
  });
  assert.ok(merged.includes("automotive"), "Yahoo about in search corpus");
  assert.ok(merged.includes("BLDC"), "scraped about in search corpus");
  assert.ok(
    themeMatch(
      {
        about: "Acme Ltd manufactures automotive components for OEMs.",
        search_text: `Acme ACME ${merged}`,
        sector: "Automobile & Ancillaries",
        sub_sector: "Auto Parts",
      },
      repm,
      filters,
    ),
    "term only on scraped site must match via merged search_text",
  );

  const rows = loadAboutRows();
  for (const theme of file.themes) {
    const a = auditTheme(theme, rows);
    assert.ok(
      a.gatedMatches > 0,
      `${theme.id} must have at least one gated match (got ${a.gatedMatches})`,
    );
  }

  const repmAudit = auditTheme(repm, rows);
  assert.equal(
    repmAudit.zeroHit.length,
    0,
    `REPM zero-hit keywords: ${repmAudit.zeroHit.join(", ")}`,
  );

  console.log("✓ themes loaded", file.themes.length, "in", groups.length, "groups");
  console.log("✓ sector filters", Object.keys(filters).length);
  console.log(
    "✓ corpus audit",
    rows.length,
    "companies ·",
    file.themes
      .map((t) => `${t.id.split("_").slice(-1)[0]}:${auditTheme(t, rows).gatedMatches}`)
      .join(" · "),
  );

  console.log("\nAll theme checks passed.");
}

main();
