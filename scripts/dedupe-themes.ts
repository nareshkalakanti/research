/**
 * Remove functionally duplicate themes (identical or near-identical match sets).
 *
 *   npx tsx scripts/dedupe-themes.ts
 *   npx tsx scripts/dedupe-themes.ts --dry-run
 */
import fs from "fs";
import path from "path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { loadThemes } from "../src/lib/themes";
import { themeMatch } from "../src/lib/theme-match";
import { loadAboutRows } from "../src/lib/theme-audit";
import { patternMatches } from "../src/lib/pattern";

const DATA = path.join(process.cwd(), "data");
const MASTER = path.join(DATA, "master_themes.json");
const SAVED = path.join(DATA, "saved_searches.db");

/** removed id → canonical id (saved searches remapped). */
export const THEME_MERGE_MAP: Record<string, string> = {
  semi_hbm_memory_supercycle: "semi_advanced_packaging",
  india_semi_packaging_osat: "semi_advanced_packaging",
  dc_rack_density_cooling: "ai_datacenter_cooling_optical_fabric",
  india_green_steel_h2_dri: "india_steel_safeguard_duty",
  ai_spacetech_onorbit_edge_compute: "us_space_direct_to_cell",
  india_specialty_chemicals_china_plus_1: "india_specialty_chemicals_cdmO",
  semi_euv_lithography_tools: "semi_sovereignty_fab_programs",
  india_mining_auction_speed: "india_mining_critical_minerals_kabil",
  india_mining_4_digital: "india_mining_critical_minerals_kabil",
};

type RawTheme = {
  id: string;
  pattern?: string;
  keywords?: string[];
  [key: string]: unknown;
};

function parseArgs() {
  return { dryRun: process.argv.includes("--dry-run") };
}

function mergeKeywordsInto(
  keep: RawTheme,
  drop: RawTheme,
  max = 24,
): void {
  const have = new Set(
    (Array.isArray(keep.keywords) ? keep.keywords : [])
      .map((k) => String(k).trim())
      .filter(Boolean),
  );
  const add: string[] = [];
  for (const k of Array.isArray(drop.keywords) ? drop.keywords : []) {
    const kw = String(k).trim();
    if (!kw || have.has(kw)) continue;
    have.add(kw);
    add.push(kw);
  }
  if (!add.length) return;
  const merged = [...(keep.keywords as string[]), ...add].slice(0, max);
  keep.keywords = merged;
  keep.pattern = merged.join(" | ");
}

function remapSavedSearches(dryRun: boolean): number {
  if (!fs.existsSync(SAVED)) return 0;
  const db = new Database(SAVED);
  const rows = db
    .prepare(`SELECT id, theme_ids FROM saved_searches`)
    .all() as Array<{ id: number; theme_ids: string }>;
  let updated = 0;
  for (const row of rows) {
    const ids = row.theme_ids
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const mapped = THEME_MERGE_MAP[id] ?? id;
      if (seen.has(mapped)) continue;
      seen.add(mapped);
      out.push(mapped);
    }
    if (out.join(",") === ids.join(",")) continue;
    updated += 1;
    if (!dryRun) {
      db.prepare(`UPDATE saved_searches SET theme_ids = ? WHERE id = ?`).run(
        out.join(","),
        row.id,
      );
    }
  }
  db.close();
  return updated;
}

function findAutoDuplicates(
  themes: RawTheme[],
  rows: ReturnType<typeof loadAboutRows>,
): Record<string, string> {
  const loaded = loadThemes().themes.filter((t) =>
    themes.some((r) => r.id === t.id),
  );
  const tickers = new Map(
    loaded.map((t) => {
      const s = new Set<string>();
      for (const r of rows) if (themeMatch(r, t)) s.add(r.ticker);
      return [t.id, s];
    }),
  );

  const auto: Record<string, string> = {};
  const ids = loaded.map((t) => t.id).sort();

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i]!;
      const b = ids[j]!;
      const sa = tickers.get(a)!;
      const sb = tickers.get(b)!;
      if (sa.size < 5 || sb.size < 5) continue;
      let inter = 0;
      for (const t of sa) if (sb.has(t)) inter += 1;
      const jacc = inter / (sa.size + sb.size - inter);
      const ta = loaded.find((t) => t.id === a)!;
      const tb = loaded.find((t) => t.id === b)!;
      const samePattern =
        ta.display_pattern.trim() === tb.display_pattern.trim();
      if (jacc >= 0.98 || (samePattern && sa.size === sb.size)) {
        auto[b] = a;
      }
    }
  }
  return auto;
}

function main() {
  const { dryRun } = parseArgs();
  if (!fs.existsSync(MASTER)) {
    console.error(`Missing ${MASTER}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(MASTER, "utf8")) as {
    meta: Record<string, unknown>;
    themes: RawTheme[];
  };
  const rows = loadAboutRows();
  const removeIds = new Set(Object.keys(THEME_MERGE_MAP));
  const byId = new Map(raw.themes.map((t) => [t.id, t]));

  for (const [dropId, keepId] of Object.entries(THEME_MERGE_MAP)) {
    const drop = byId.get(dropId);
    const keep = byId.get(keepId);
    if (drop && keep) mergeKeywordsInto(keep, drop);
  }

  const auto = findAutoDuplicates(raw.themes, rows);
  for (const [dropId, keepId] of Object.entries(auto)) {
    if (removeIds.has(dropId) || removeIds.has(keepId)) continue;
    console.log(`  auto-dup: ${dropId} → ${keepId}`);
    removeIds.add(dropId);
    THEME_MERGE_MAP[dropId] = keepId;
    const drop = byId.get(dropId);
    const keep = byId.get(keepId);
    if (drop && keep) mergeKeywordsInto(keep, drop);
  }

  const kept = raw.themes.filter((t) => !removeIds.has(t.id));
  const removed = raw.themes.filter((t) => removeIds.has(t.id)).map((t) => t.id);

  console.log(
    `${dryRun ? "[dry-run] " : ""}Removing ${removed.length} duplicate themes:`,
  );
  for (const id of removed) {
    console.log(`  - ${id} → ${THEME_MERGE_MAP[id]}`);
  }
  console.log(`Themes: ${raw.themes.length} → ${kept.length}`);

  const savedUpdates = remapSavedSearches(dryRun);
  if (savedUpdates) console.log(`Saved searches remapped: ${savedUpdates}`);

  if (dryRun) return;

  raw.themes = kept;
  raw.meta.theme_count = kept.length;
  raw.meta.removed_duplicates = Object.fromEntries(
    removed.map((id) => [id, THEME_MERGE_MAP[id]]),
  );
  raw.meta.deduped = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(MASTER, `${JSON.stringify(raw, null, 2)}\n`);

  execSync("npx tsx scripts/import-master-themes.ts", {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  execSync("npx tsx scripts/build-theme-sector-filters.ts", {
    stdio: "inherit",
    cwd: process.cwd(),
  });
}

main();
