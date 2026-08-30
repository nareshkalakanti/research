/**
 * Normalize data/master_themes.json → data/theme_keywords.json
 *
 *   npx tsx scripts/import-master-themes.ts
 */
import fs from "fs";
import path from "path";

const DATA = path.join(process.cwd(), "data");
const SRC = path.join(DATA, "master_themes.json");
const OUT = path.join(DATA, "theme_keywords.json");

/** Nanocap Champs proxy themes — cap at ₹500 Cr mcap. */
const NANOCAP_THEME_IDS = new Set([
  "solar_epc_bess",
  "packaging_gravure",
  "aseptic_food_processing",
  "micro_irrigation",
  "seismic_geophysical",
  "progressive_cavity_pumps",
  "pvc_pipes_fittings",
]);

/** Listed Venture Capital proxy themes — cap at ₹6,000 Cr mcap. */
const LVC_THEME_IDS = new Set([
  "hospitals_healthcare",
  "real_estate_redevelopment",
  "foundry_consumables",
  "gems_jewellery_lgd",
  "tmt_royalty",
  "coated_steel",
  "auto_components_adas",
  "pib_additives",
  "merchant_banking",
  "financials_infra",
  "gilts_primary_dealer",
]);

type RawTheme = {
  id: string;
  cluster?: string;
  name: string;
  blog_theme: string;
  display_pattern?: string;
  pattern?: string;
  keywords?: string[];
  definitions?: Record<string, string>;
  keyword_definitions?: Record<string, string>;
  proxies?: string[];
};

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Missing ${SRC}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(SRC, "utf8")) as {
    meta: Record<string, unknown>;
    themes: RawTheme[];
  };

  const themeMaxMcap: Record<string, number> = {};
  for (const id of NANOCAP_THEME_IDS) themeMaxMcap[id] = 500;
  for (const id of LVC_THEME_IDS) themeMaxMcap[id] = 6000;

  const themes = raw.themes.map((t) => {
    const keywords = Array.isArray(t.keywords)
      ? t.keywords
      : String(t.display_pattern ?? t.pattern ?? "")
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean);
    // keywords[] is source of truth — stale display_pattern fields must not drop new terms
    const display_pattern = keywords.join(" | ");
    const defs = t.keyword_definitions ?? t.definitions;
    return {
      id: t.id,
      cluster: t.cluster,
      name: t.name,
      blog_theme: t.blog_theme,
      display_pattern,
      keywords,
      ...(defs && Object.keys(defs).length ? { keyword_definitions: defs } : {}),
      ...(t.proxies?.length ? { proxies: t.proxies } : {}),
    };
  });

  const out = {
    meta: {
      ...raw.meta,
      syntax:
        raw.meta.syntax ??
        "+ means AND, | means OR (AND binds tighter inside a clause)",
      updated: raw.meta.updated ?? new Date().toISOString().slice(0, 10),
      theme_count: themes.length,
      theme_max_mcap_cr: themeMaxMcap,
      nanocap_theme_ids: [...NANOCAP_THEME_IDS],
      lvc_theme_ids: [...LVC_THEME_IDS],
    },
    themes,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${OUT} — ${themes.length} themes`);

  let drift = 0;
  for (const t of themes) {
    const fromPattern = t.display_pattern
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    if (fromPattern.length !== t.keywords.length) {
      drift += 1;
      console.warn(
        `WARN ${t.id}: keywords (${t.keywords.length}) ≠ display_pattern clauses (${fromPattern.length})`,
      );
    }
  }
  if (drift === 0) {
    console.log("✓ all theme keywords synced to display_pattern");
  }

  console.log(
    `Mcap caps: ${NANOCAP_THEME_IDS.size} nanocap (≤500 Cr), ${LVC_THEME_IDS.size} LVC (≤6000 Cr)`,
  );
}

main();
