/**
 * Theme load + sector-gate match tests.
 * Run: npx tsx scripts/test-themes.ts
 */
import assert from "node:assert/strict";
import { loadThemes, groupThemesByBlog, themesByIds } from "../src/lib/themes";
import { matchedKeywords } from "../src/lib/pattern";
import {
  loadThemeSectorFilters,
  themeMatch,
} from "../src/lib/theme-match";
import { auditAllThemes, loadAboutRows } from "../src/lib/theme-audit";
import { mergeAboutSourcesForSearch } from "../src/lib/db";

function main() {
  const file = loadThemes();
  assert.equal(file.themes.length, 1, `expected 1 theme, got ${file.themes.length}`);
  assert.equal(
    file.themes[0]!.id,
    "india_repm_magnet_localization",
    "expected REPM theme only",
  );

  const groups = groupThemesByBlog(file.themes);
  assert.equal(groups.length, 1, `expected 1 blog group, got ${groups.length}`);

  const filters = loadThemeSectorFilters();
  assert.equal(
    Object.keys(filters).length,
    1,
    `expected 1 sector filter, got ${Object.keys(filters).length}`,
  );
  assert.ok(
    filters.india_repm_magnet_localization,
    "sector filter missing india_repm_magnet_localization",
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
  const audits = auditAllThemes(file.themes, rows);
  assert.equal(audits.length, 1, "audit should cover REPM theme");

  const a = audits[0]!;
  assert.ok(a.gatedMatches > 0, "REPM must have at least one gated match");
  assert.equal(a.zeroHit.length, 0, `zero-hit keywords: ${a.zeroHit.join(", ")}`);

  console.log("✓ themes loaded", file.themes.length, "in", groups.length, "group");
  console.log("✓ sector filters", Object.keys(filters).length);
  console.log(
    "✓ corpus audit",
    rows.length,
    "companies ·",
    a.gatedMatches,
    "REPM matches · no zero-hit keywords",
  );
  console.log("\nAll theme checks passed.");
}

main();
