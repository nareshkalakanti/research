/**
 * Tighten theme keywords for distinctive stock discovery (not generic sector dumps).
 *
 *   npx tsx scripts/fix-theme-keywords.ts
 *   npx tsx scripts/fix-theme-keywords.ts --dry-run
 */
import fs from "fs";
import path from "path";
import { execSync } from "node:child_process";
import { patternMatches } from "../src/lib/pattern";
import { loadThemes, type Theme } from "../src/lib/themes";
import { auditTheme, loadAboutRows, looseAndMatch } from "../src/lib/theme-audit";

const DATA = path.join(process.cwd(), "data");
const MASTER = path.join(DATA, "master_themes.json");
const RESEARCH_PATH = path.join(DATA, "theme_research_patterns.json");

/** Standalone terms too broad for theme discovery — drop unless part of AND phrase. */
const BROAD_STANDALONE = new Set([
  "steel",
  "mining",
  "automotive",
  "construction",
  "software",
  "logistics",
  "hospital",
  "satellite",
  "semiconductor",
  "formulations",
  "formulation",
  "aerospace",
  "defense",
  "defence",
  "epc",
  "marine",
  "shipping",
  "renewable",
  "renewable energy",
  "power generation",
  "iron and steel",
  "data center",
  "data centre",
  "transmission",
  "port",
  "turbine",
  "foundry",
  "fabrication",
  "auto ancillary",
  "specialty chemicals",
  "power transformer",
  "switchgear",
  "cooling",
  "premium",
  "hospitality",
  "apparel",
  "women",
  "it services",
  "solar power",
  "solar",
  "captive",
  "utility scale",
  "api",
  "active pharmaceutical",
  "logistics",
  "freight",
  "charter",
  "vessel",
  "aircraft",
  "drone",
  "drones",
  "rocket",
  "propulsion",
  "silicon",
  "wafer",
  "fab",
  "tungsten",
  "asic",
  "vlsi",
  "formulations",
  "brass",
  "refractory",
  "refractories",
  "offshore",
  "diving",
  "ship repair",
  "food processing",
  "flexible packaging",
  "microfinance",
  "blockchain",
  "fintech",
  "obesity",
  "peptide",
]);

const SAFE_ACRONYMS = new Set([
  "CDMO",
  "OSAT",
  "BESS",
  "TMT",
  "VSAT",
  "CTC",
  "NBFC",
  "PIB",
  "BOPP",
  "CRGO",
  "EHV",
  "XLPE",
  "SMT",
  "PCB",
  "EMS",
  "UAV",
  "SSLV",
  "UAS",
  "FAL",
  "C295",
  "EDA",
  "RTL",
  "SMR",
  "ATMP",
  "HBM",
  "DRAM",
  "OSD",
  "WHO-GMP",
  "USFDA",
  "FSI",
  "SRA",
  "TDR",
  "IQF",
  "CPVC",
  "uPVC",
]);

const MAX_CORPUS_HITS = 45;
const MAX_CORPUS_AND = 80;
const MAX_KEYWORDS = 14;

/** Small set of vetted multi-word extras (never generic sector words). */
const TIGHT_EXTRAS: Record<string, string[]> = {
  copper_value_add: [
    "bus bars",
    "copper wire",
    "copper tubes",
    "copper scrap",
    "enamelled copper",
    "continuously transposed",
  ],
  power_electrical: [
    "bus bars",
    "power transformer",
    "distribution transformer",
    "CRGO",
    "extra high voltage",
  ],
  foundry_consumables: ["foundry chemicals", "metal casting"],
  pib_additives: ["polyisobutylene", "PIB"],
  hospitals_healthcare: [
    "multi-specialty hospital",
    "multispecialty",
    "tertiary care",
  ],
  real_estate_redevelopment: ["redevelopment", "slum rehabilitation"],
  pharma_cdmo: ["CDMO", "contract manufacturing", "injectables", "bulk drug"],
  electronics_ems: [
    "PCB assembly",
    "printed circuit + assembly",
    "electronic manufacturing services",
  ],
  gems_jewellery_lgd: ["gold jewellery", "lab grown", "laboratory grown"],
  seismic_geophysical: ["seismic survey", "oil and gas exploration"],
  gilts_primary_dealer: ["government securities", "treasury bills"],
  semi_advanced_packaging: [
    "OSAT",
    "semiconductor packaging",
    "semiconductor + assembly",
  ],
  us_glp1_second_order: ["semaglutide", "anti-obesity", "weight loss"],
  us_defense_autonomous_swarm: [
    "unmanned + aerial",
    "UAV",
    "counter-drone",
    "electronic warfare",
  ],
  us_tokenization_private_credit: [
    "blockchain",
    "digital asset",
    "securitization",
  ],
};

/** Must-keep keywords for core investable themes (multi-word / domain-specific). */
const REQUIRED_KEYWORDS: Record<string, string[]> = {
  seismic_geophysical: [
    "seismic",
    "geophysical",
    "seismic data",
    "oil and gas exploration",
    "exploration + services",
  ],
  solar_epc_bess: [
    "solar + EPC",
    "rooftop + solar",
    "utility scale + solar",
    "BESS",
    "battery energy storage",
  ],
  micro_irrigation: ["drip + irrigation", "micro irrigation", "sprinkler"],
  aseptic_food_processing: ["mango pulp", "fruit + pulp", "aseptic", "spray dried"],
  packaging_gravure: ["flexible packaging", "BOPP", "gravure", "rotogravure"],
};

/** Minimal India-validated keywords when research terms have zero corpus matches. */
const FALLBACK_KEYWORDS: Record<string, string[]> = {
  india_front_end_fab: ["cleanroom", "semiconductor + assembly", "wafer"],
  india_maritime_tonnage_tax: ["shipping company", "tanker", "dry bulk"],
  india_maritime_port_concessions: ["container terminal", "dry bulk", "port terminal"],
  india_maritime_services_crewing: ["shipping company", "ship management", "marine services"],
  india_inland_first_supply_chain: ["auto ancillary", "supply chain + auto", "logistics + auto"],
  us_glp1_second_order: ["semaglutide", "anti-obesity", "bariatric", "weight loss"],
  ai_spacetech_orbital_datacenters: ["data center + construction"],
  semi_materials_weaponization: ["tungsten", "gallium", "specialty gas + semiconductor"],
  specialty_branded_pharma: [
    "gastroenterology",
    "nephrology",
    "rheumatology",
    "oncology",
    "branded + generics",
  ],
};

const DROP_KEYWORDS: Record<string, Set<string>> = {
  copper_value_add: new Set(["copper + HVAC", "BLDC + motor", "HVLS", "brass"]),
  offshore_diving: new Set(["platform + supply"]),
  merchant_banking: new Set(["M&A + advisory"]),
  hospitals_healthcare: new Set(["hospital"]),
  electronics_ems: new Set(["IT + peripherals"]),
  auto_components_adas: new Set(["automotive", "auto ancillary", "auto component"]),
  packaging_gravure: new Set(["packaging + solutions"]),
  power_electrical: new Set(["ferrite", "bobbin", "transformer"]),
  india_maritime_port_concessions: new Set(["logistics", "Adani Ports"]),
  mukerjea_gcc_expansion: new Set(["software", "IT services"]),
  pharma_cdmo: new Set(["formulations", "active pharmaceutical"]),
  specialty_branded_pharma: new Set(["formulations"]),
};

type Row = ReturnType<typeof loadAboutRows>[number];
type RawTheme = Record<string, unknown> & {
  id: string;
  pattern?: string;
  keywords?: string[];
  definitions?: Record<string, string>;
};

function loadResearchPatterns(): Record<string, string> {
  if (!fs.existsSync(RESEARCH_PATH)) return {};
  const raw = JSON.parse(fs.readFileSync(RESEARCH_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "meta" || typeof v !== "string") continue;
    out[k] = v;
  }
  return out;
}

function uniqKeywords(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of list) {
    const key = k.trim();
    if (!key) continue;
    const norm = key.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(key);
  }
  return out;
}

function seedKeywords(theme: RawTheme, research: Record<string, string>): string[] {
  const id = String(theme.id);
  const fromResearch = research[id]
    ? research[id]!.split("|").map((s) => s.trim()).filter(Boolean)
    : [];
  const fromDefs = Object.keys(theme.definitions ?? {});
  const fromPattern = String(theme.pattern ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  return uniqKeywords([
    ...fromResearch,
    ...fromDefs,
    ...fromPattern,
    ...(TIGHT_EXTRAS[id] ?? []),
    ...(FALLBACK_KEYWORDS[id] ?? []),
  ]);
}

function keywordHits(rows: Row[], keyword: string): number {
  let n = 0;
  for (const r of rows) {
    if (patternMatches(r.text, keyword)) n += 1;
  }
  return n;
}

function isBroadStandalone(kw: string): boolean {
  const k = kw.trim();
  if (k.includes("+")) return false;
  if (SAFE_ACRONYMS.has(k)) return false;
  const words = k.split(/\s+/);
  if (words.length >= 3) return false;
  return BROAD_STANDALONE.has(k.toLowerCase());
}

function maxHitsFor(kw: string): number {
  if (kw.includes("+")) return MAX_CORPUS_AND;
  const words = kw.split(/\s+/).filter(Boolean);
  if (words.length >= 3) return MAX_CORPUS_AND;
  if (words.length === 2) return 55;
  return MAX_CORPUS_HITS;
}

function scoreKeyword(
  kw: string,
  rows: Row[],
): { corpus: number; loose: number } {
  const corpus = keywordHits(rows, kw);
  let loose = 0;
  for (const r of rows) {
    if (patternMatches(r.text, kw) && looseAndMatch(r.text, kw)) loose += 1;
  }
  return { corpus, loose };
}

function fixThemeKeywords(
  themeId: string,
  theme: Theme,
  seed: string[],
  rows: Row[],
): { keywords: string[]; removed: string[] } {
  const removed: string[] = [];
  const drop = DROP_KEYWORDS[themeId] ?? new Set<string>();
  const required = new Set(REQUIRED_KEYWORDS[themeId] ?? []);
  const scored: Array<{ kw: string; corpus: number }> = [];

  for (const kw of seed) {
    if (drop.has(kw)) {
      removed.push(kw);
      continue;
    }
    if (!required.has(kw) && isBroadStandalone(kw)) {
      removed.push(kw);
      continue;
    }
    const s = scoreKeyword(kw, rows);
    if (s.corpus === 0 && !required.has(kw)) {
      removed.push(kw);
      continue;
    }
    if (
      !required.has(kw) &&
      s.corpus > maxHitsFor(kw)
    ) {
      removed.push(kw);
      continue;
    }
    if (!required.has(kw) && s.loose > 8) {
      removed.push(kw);
      continue;
    }
    scored.push({ kw, corpus: s.corpus });
  }

  scored.sort((a, b) => b.corpus - a.corpus);

  const keywords: string[] = [];
  for (const req of REQUIRED_KEYWORDS[themeId] ?? []) {
    if (keywordHits(rows, req) > 0 && !keywords.includes(req)) keywords.push(req);
  }
  for (const s of scored) {
    if (keywords.length >= MAX_KEYWORDS) break;
    if (!keywords.includes(s.kw)) keywords.push(s.kw);
  }
  if (keywords.length === 0) {
    for (const kw of FALLBACK_KEYWORDS[themeId] ?? []) {
      if (keywordHits(rows, kw) > 0) keywords.push(kw);
    }
  }

  return { keywords: uniqKeywords(keywords), removed };
}

function parseArgs() {
  return { dryRun: process.argv.includes("--dry-run") };
}

function main() {
  const { dryRun } = parseArgs();
  if (!fs.existsSync(MASTER)) {
    console.error(`Missing ${MASTER}`);
    process.exit(1);
  }

  const research = loadResearchPatterns();
  const raw = JSON.parse(fs.readFileSync(MASTER, "utf8")) as {
    meta: Record<string, unknown>;
    themes: RawTheme[];
  };
  const rows = loadAboutRows();
  const file = loadThemes();

  let totalRemoved = 0;
  let themesWithZeroHits = 0;
  let themesWithZeroGated = 0;

  for (let i = 0; i < raw.themes.length; i += 1) {
    const t = raw.themes[i]!;
    const id = String(t.id);
    const loaded = file.themes.find((x) => x.id === id);
    if (!loaded) continue;

    const seed = seedKeywords(t, research);
    const { keywords, removed } = fixThemeKeywords(id, loaded, seed, rows);
    totalRemoved += removed.length;

    const pattern = keywords.join(" | ");
    t.keywords = keywords;
    t.pattern = pattern;
    if (research[id]) t.research_pattern = research[id];

    const themeObj = { ...loaded, display_pattern: pattern, keywords };
    const audit = auditTheme(themeObj, rows);
    if (audit.zeroHit.length > 0) themesWithZeroHits += 1;
    if (audit.gatedMatches === 0) themesWithZeroGated += 1;
  }

  if (!dryRun) {
    raw.meta.updated = new Date().toISOString().slice(0, 10);
    raw.meta.keyword_fix = "scripts/fix-theme-keywords.ts (tight)";
    fs.writeFileSync(MASTER, `${JSON.stringify(raw, null, 2)}\n`);
  }

  console.log(`${dryRun ? "[dry-run] " : ""}Tightened ${raw.themes.length} themes`);
  console.log(`  removed ${totalRemoved} broad/zero-gated keywords`);
  console.log(`  zero-hit kw themes: ${themesWithZeroHits}`);
  console.log(`  zero gated themes: ${themesWithZeroGated}`);

  if (!dryRun) {
    execSync("npx tsx scripts/import-master-themes.ts", {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    execSync("npx tsx scripts/build-theme-sector-filters.ts", {
      stdio: "inherit",
      cwd: process.cwd(),
    });
  }
}

main();
