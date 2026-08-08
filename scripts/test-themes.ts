/**
 * Theme load + match smoke test.
 * Run: npx tsx scripts/test-themes.ts
 */
import assert from "node:assert/strict";
import { loadThemes, groupThemesByBlog, themesByIds } from "../src/lib/themes";
import {
  combinePatterns,
  matchedKeywords,
  patternMatches,
} from "../src/lib/pattern";

function main() {
  const file = loadThemes();
  assert.ok(file.themes.length >= 49, `expected ≥49 themes, got ${file.themes.length}`);
  const groups = groupThemesByBlog(file.themes);
  assert.ok(groups.length >= 10, `expected groups, got ${groups.length}`);

  const required = [
    "pharma_cdmo",
    "electronics_ems",
    "packaging_materials",
    "hospitals_healthcare",
    "dc_hardware_networking",
    "ai_applications",
  ];
  for (const id of required) {
    assert.ok(
      file.themes.some((t) => t.id === id),
      `missing theme ${id}`,
    );
  }

  const cdmo = themesByIds(["pharma_cdmo"]);
  assert.equal(cdmo.length, 1);
  const pattern = combinePatterns(cdmo.map((t) => t.display_pattern));
  assert.ok(patternMatches("We are a leading CDMO and API intermediates manufacturer", pattern));
  assert.ok(
    !patternMatches("We provide gold loan and NBFC services only", pattern),
    "CDMO should not match NBFC blurb",
  );

  const ems = themesByIds(["electronics_ems"]);
  const emsPat = combinePatterns(ems.map((t) => t.display_pattern));
  assert.ok(
    patternMatches(
      "Electronics manufacturing services with PCB assembly and SMT lines",
      emsPat,
    ),
  );

  const hits = matchedKeywords(
    "Contract manufacturing of pharmaceutical formulations and injectables under WHO-GMP",
    pattern,
  );
  assert.ok(hits.length > 0, "expected keyword hits");

  console.log("✓ themes loaded", file.themes.length, "in", groups.length, "groups");
  console.log("✓ pattern match CDMO / EMS");
  console.log("✓ keyword highlights", hits.slice(0, 4));
  console.log("\nAll theme checks passed.");
}

main();
