/**
 * Derive tight sector/sub-sector gates from theme matches (distinctive stocks only).
 *
 *   npx tsx scripts/build-theme-sector-filters.ts
 */
import fs from "fs";
import path from "path";
import { loadAllCompanies } from "../src/lib/db";
import { patternMatches } from "../src/lib/pattern";
import { loadThemes } from "../src/lib/themes";

const DATA = path.join(process.cwd(), "data");
const OUT = path.join(DATA, "theme_sector_filters.json");

const FILTER_OVERRIDES: Record<
  string,
  { allow_sectors: string[]; allow_subsectors: string[]; exclude_pairs?: string[] }
> = {
  copper_value_add: {
    allow_sectors: ["Metals & Mining", "Engineering & Capital Goods"],
    allow_subsectors: [
      "Metals - Copper",
      "Mining - Copper",
      "Metal Fabrication",
      "Electrical Components & Equipments",
      "Cables",
      "Heavy Electrical Equipments",
    ],
    exclude_pairs: [
      "Diversified & Others > Commodities Trading",
      "Retail > Precious Metals, Jewellery & Watches",
    ],
  },
  power_electrical: {
    allow_sectors: ["Engineering & Capital Goods", "Metals & Mining"],
    allow_subsectors: [
      "Heavy Electrical Equipments",
      "Heavy Electrical Equipment",
      "Electrical Components & Equipments",
      "Cables",
      "Metals - Copper",
      "Power Infrastructure",
    ],
    exclude_pairs: [
      "Retail > Precious Metals, Jewellery & Watches",
      "Engineering & Capital Goods > Industrial Machinery",
    ],
  },
  solar_epc_bess: {
    allow_sectors: ["Power & Utilities", "Real Estate & Construction"],
    allow_subsectors: [
      "Renewable Energy",
      "Renewable Energy Equipment & Services",
      "Construction & Engineering",
      "Solar",
      "Power Generation",
    ],
    exclude_pairs: [
      "Metals & Mining > Iron & Steel",
      "Engineering & Capital Goods > Industrial Machinery",
      "Engineering & Capital Goods > Castings & Forgings",
    ],
  },
  packaging_gravure: {
    allow_sectors: ["Consumer Durables", "Engineering & Capital Goods"],
    allow_subsectors: [
      "Packaging",
      "Packaging & Containers",
      "Plastic Products",
      "Paper & Paper Products",
    ],
  },
  aseptic_food_processing: {
    allow_sectors: [
      "FMCG & Consumer Goods",
      "Fast Moving Consumer Goods",
      "Consumer Staples",
      "Agriculture & Agro",
    ],
    allow_subsectors: [
      "FMCG - Foods",
      "Food Products",
      "Food Processing",
      "Agro Products",
      "Beverages",
    ],
  },
  micro_irrigation: {
    allow_sectors: ["Engineering & Capital Goods", "Agro Chemicals"],
    allow_subsectors: [
      "Industrial Machinery",
      "Plastic Products",
      "Agro Chemicals",
      "Irrigation",
    ],
  },
  seismic_geophysical: {
    allow_sectors: ["Oil & Gas & Energy"],
    allow_subsectors: [
      "Oil & Gas - Equipment & Services",
      "Oil & Gas - Exploration & Production",
      "Oil & Gas - Refining & Marketing",
    ],
    exclude_pairs: [
      "Real Estate & Construction > Construction & Engineering",
      "Real Estate & Construction > Building Products - Pipes",
    ],
  },
  progressive_cavity_pumps: {
    allow_sectors: ["Engineering & Capital Goods"],
    allow_subsectors: ["Industrial Machinery", "Industrial Products"],
  },
  hospitals_healthcare: {
    allow_sectors: ["Pharmaceuticals & Healthcare", "Healthcare"],
    allow_subsectors: [
      "Hospitals & Diagnostic Centres",
      "Hospital",
      "Medical Care Facilities",
      "Healthcare Service Provider",
    ],
    exclude_pairs: [
      "Engineering & Capital Goods > Industrial Machinery",
      "Oil & Gas & Energy > Oil & Gas - Exploration & Production",
    ],
  },
  specialty_branded_pharma: {
    allow_sectors: ["Pharmaceuticals & Healthcare", "Healthcare"],
    allow_subsectors: ["Pharmaceuticals", "Biotechnology", "Drug Manufacturers - General"],
    exclude_pairs: [
      "Pharmaceuticals & Healthcare > Hospitals & Diagnostic Centres",
      "Healthcare > Hospital",
      "Healthcare > Medical Care Facilities",
    ],
  },
  real_estate_redevelopment: {
    allow_sectors: ["Real Estate & Construction"],
    allow_subsectors: [
      "Real Estate",
      "Construction & Engineering",
      "Residential Commercial Projects",
    ],
    exclude_pairs: [
      "Financial Services > Finance & Investments",
      "Financial Services > Asset Management",
    ],
  },
  foundry_consumables: {
    allow_sectors: ["Engineering & Capital Goods", "Metals & Mining"],
    allow_subsectors: [
      "Castings & Forgings",
      "Industrial Products",
      "Specialty Chemicals",
    ],
  },
  auto_components_adas: {
    allow_sectors: ["Automobile & Ancillaries"],
    allow_subsectors: ["Auto Parts", "Auto Ancillaries", "Tyres & Rubber"],
    exclude_pairs: [
      "IT & Technology > IT Services & Consulting",
      "Engineering & Capital Goods > Industrial Machinery",
    ],
  },
  gems_jewellery_lgd: {
    allow_sectors: ["Retail", "Consumer Durables"],
    allow_subsectors: [
      "Precious Metals, Jewellery & Watches",
      "Gems & Jewellery",
    ],
  },
  electronics_ems: {
    allow_sectors: ["Engineering & Capital Goods", "IT & Technology"],
    allow_subsectors: [
      "Electronic Equipments",
      "Electronics & Technology",
      "Computers Hardware & Equipments",
    ],
    exclude_pairs: ["IT & Technology > IT Services & Consulting"],
  },
  pharma_cdmo: {
    allow_sectors: ["Pharmaceuticals & Healthcare", "Healthcare"],
    allow_subsectors: [
      "Pharmaceuticals",
      "Biotechnology",
      "Labs & Life Sciences Services",
    ],
  },
  offshore_diving: {
    allow_sectors: ["Oil & Gas & Energy", "Engineering & Capital Goods"],
    allow_subsectors: [
      "Oil & Gas - Equipment & Services",
      "Ship Building",
      "Construction & Engineering",
    ],
    exclude_pairs: ["IT & Technology > IT Services & Consulting"],
  },
  india_steel_safeguard_duty: {
    allow_sectors: ["Metals & Mining"],
    allow_subsectors: [
      "Iron & Steel",
      "Iron & Steel Products",
      "Metals - Diversified",
      "Mining - Iron Ore",
    ],
  },
  india_mining_critical_minerals_kabil: {
    allow_sectors: ["Metals & Mining"],
    allow_subsectors: [
      "Mining - Diversified",
      "Mining - Iron Ore",
      "Mining - Manganese",
      "Metals - Diversified",
      "Non-energy minerals",
    ],
  },
  india_maritime_tonnage_tax: {
    allow_sectors: ["Transportation & Logistics", "Oil & Gas & Energy"],
    allow_subsectors: [
      "Shipping",
      "Logistics",
      "Marine Services",
      "Oil & Gas - Refining & Marketing",
    ],
  },
  india_maritime_port_concessions: {
    allow_sectors: ["Transportation & Logistics", "Infrastructure"],
    allow_subsectors: [
      "Ports & Port Services",
      "Logistics",
      "Shipping",
    ],
  },
  india_maritime_services_crewing: {
    allow_sectors: ["Transportation & Logistics"],
    allow_subsectors: ["Shipping", "Marine Services", "Logistics"],
  },
  india_aerospace_indigenization_ip: {
    allow_sectors: ["Engineering & Capital Goods", "Aerospace & Defense"],
    allow_subsectors: [
      "Aerospace & Defense",
      "Defence",
      "Electronic Equipments",
    ],
  },
  india_avionics_defense_electronics: {
    allow_sectors: ["Engineering & Capital Goods", "Aerospace & Defense"],
    allow_subsectors: ["Aerospace & Defense", "Defence", "Electronic Equipments"],
  },
  india_drones_space_privatization: {
    allow_sectors: ["Engineering & Capital Goods", "Aerospace & Defense"],
    allow_subsectors: [
      "Aerospace & Defense",
      "Defence",
      "Electronic Equipments",
    ],
  },
  satcom_vsat: {
    allow_sectors: ["Telecommunications", "Engineering & Capital Goods"],
    allow_subsectors: [
      "Telecom Equipment",
      "Satellite Communication",
      "Electronic Equipments",
    ],
  },
  us_space_direct_to_cell: {
    allow_sectors: ["Engineering & Capital Goods", "Telecommunications"],
    allow_subsectors: [
      "Aerospace & Defense",
      "Defence",
      "Telecom Equipment",
      "Satellite Communication",
    ],
  },
  us_nuclear_baseload_ai: {
    allow_sectors: ["Power & Utilities"],
    allow_subsectors: ["Power Generation", "Power Infrastructure", "Renewable Energy"],
    exclude_pairs: [
      "IT & Technology > IT Services & Consulting",
      "Financial Services > Finance & Investments",
    ],
  },
  us_glp1_second_order: {
    allow_sectors: ["Pharmaceuticals & Healthcare", "Healthcare"],
    allow_subsectors: [
      "Pharmaceuticals",
      "Biotechnology",
      "Wellness Services",
    ],
    exclude_pairs: [
      "Pharmaceuticals & Healthcare > Hospitals & Diagnostic Centres",
      "Healthcare > Medical Care Facilities",
    ],
  },
  us_tokenization_private_credit: {
    allow_sectors: ["Financial Services", "IT & Technology"],
    allow_subsectors: [
      "Finance & Investments",
      "Capital Markets",
      "Other Financial Services",
    ],
  },
  us_defense_autonomous_swarm: {
    allow_sectors: ["Engineering & Capital Goods", "Aerospace & Defense"],
    allow_subsectors: ["Aerospace & Defense", "Defence", "Electronic Equipments"],
  },
  dc_construction_labor: {
    allow_sectors: ["Real Estate & Construction", "Engineering & Capital Goods"],
    allow_subsectors: [
      "Construction & Engineering",
      "Civil Construction",
      "Heavy Engineering",
    ],
    exclude_pairs: [
      "Financial Services > Housing Finance",
      "Metals & Mining > Iron & Steel",
    ],
  },
  ai_datacenter_cooling_optical_fabric: {
    allow_sectors: ["Engineering & Capital Goods", "Consumer Durables"],
    allow_subsectors: [
      "Heavy Electrical Equipments",
      "Electronic Equipments",
      "Home Electronics & Appliances",
    ],
    exclude_pairs: ["Automobile & Ancillaries > Auto Parts"],
  },
  ai_datacenter_nextgen_power: {
    allow_sectors: ["Engineering & Capital Goods", "Power & Utilities"],
    allow_subsectors: [
      "Heavy Electrical Equipments",
      "Electrical Components & Equipments",
      "Power Infrastructure",
    ],
  },
  dc_power_grid_interconnection: {
    allow_sectors: ["Power & Utilities", "Engineering & Capital Goods"],
    allow_subsectors: [
      "Power Infrastructure",
      "Power Generation",
      "Heavy Electrical Equipments",
    ],
  },
  semi_advanced_packaging: {
    allow_sectors: ["Engineering & Capital Goods", "IT & Technology"],
    allow_subsectors: [
      "Electronic Equipments",
      "Computers Hardware & Equipments",
      "Electronics & Technology",
    ],
  },
  mukerjea_rise_of_indian_women: {
    allow_sectors: ["Retail", "Consumer Durables", "Automobile & Ancillaries"],
    allow_subsectors: [
      "Personal Care",
      "Apparel",
      "Precious Metals, Jewellery & Watches",
      "Two Wheelers",
    ],
  },
  mukerjea_gcc_expansion: {
    allow_sectors: ["IT & Technology"],
    allow_subsectors: [
      "IT Services & Consulting",
      "Software Products",
    ],
  },
  india_inland_first_supply_chain: {
    allow_sectors: ["Automobile & Ancillaries", "Transportation"],
    allow_subsectors: ["Auto Parts", "Logistics", "Auto Ancillaries"],
  },
  financials_infra: {
    allow_sectors: ["Financial Services"],
    allow_subsectors: [
      "Finance & Investments",
      "Other Financial Services",
      "Asset Management",
      "Housing Finance",
    ],
  },
  merchant_banking: {
    allow_sectors: ["Financial Services"],
    allow_subsectors: ["Capital Markets", "Finance & Investments"],
  },
  gilts_primary_dealer: {
    allow_sectors: ["Financial Services"],
    allow_subsectors: ["Capital Markets", "Finance & Investments"],
  },
};

type PairCount = { pair: string; sector: string; sub: string; n: number };

function main() {
  const minShare = 0.5;
  const file = loadThemes();
  const rows = loadAllCompanies().filter(
    (c) => (c.search_text || c.about || "").trim().length >= 30,
  );

  const filters: Record<
    string,
    { allow_sectors: string[]; allow_subsectors: string[]; exclude_pairs?: string[] }
  > = {};

  for (const theme of file.themes) {
    if (FILTER_OVERRIDES[theme.id]) continue;

    const pairMap = new Map<string, PairCount>();
    for (const r of rows) {
      const text = r.search_text?.trim() || r.about?.trim() || "";
      if (!text || !patternMatches(text, theme.display_pattern)) continue;
      const sector = r.sector?.trim() || "";
      const sub = r.sub_sector?.trim() || "";
      if (!sector && !sub) continue;
      const pair = `${sector} > ${sub}`;
      const cur = pairMap.get(pair) ?? { pair, sector, sub, n: 0 };
      cur.n += 1;
      pairMap.set(pair, cur);
    }

    const hits = [...pairMap.values()].sort((a, b) => b.n - a.n);
    if (!hits.length) continue;

    const total = hits.reduce((s, h) => s + h.n, 0);
    const kept = hits.filter((h) => h.n / total >= minShare && h.n >= 2);
    const sample = (kept.length ? kept : hits.slice(0, 3)).slice(0, 4);

    const allow_sectors = [...new Set(sample.map((h) => h.sector).filter(Boolean))].slice(
      0,
      2,
    );
    const allow_subsectors = [
      ...new Set(sample.map((h) => h.sub).filter(Boolean)),
    ].slice(0, 4);

    if (!allow_sectors.length && !allow_subsectors.length) continue;
    filters[theme.id] = { allow_sectors, allow_subsectors };
  }

  for (const [id, override] of Object.entries(FILTER_OVERRIDES)) {
    filters[id] = override;
  }

  const out = {
    meta: {
      source_db: "data/classifications.db",
      rule: "match = keyword AND (sub_sector in allow_subsectors OR sector in allow_sectors) AND pair NOT in exclude_pairs",
      updated: new Date().toISOString().slice(0, 10),
      aligned_to: "theme_keywords.json",
      built_by: "scripts/build-theme-sector-filters.ts",
      min_share: minShare,
      mode: "tight",
    },
    filters,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `Wrote ${OUT} — ${Object.keys(filters).length}/${file.themes.length} themes with sector gates`,
  );
}

main();
