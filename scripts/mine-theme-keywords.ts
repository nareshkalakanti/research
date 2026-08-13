/**
 * Mine company About text for theme keyword hit rates (same matcher as scans).
 *
 *   npx tsx scripts/mine-theme-keywords.ts
 *   npx tsx scripts/mine-theme-keywords.ts --theme copper_value_chain
 *   npx tsx scripts/mine-theme-keywords.ts --suggest
 *
 * Reads: data/company_about.db, data/themes.json, data/theme_candidates.json
 */
import fs from "fs";
import path from "path";
import { loadThemes } from "../src/lib/themes";
import { loadAllCompanies } from "../src/lib/db";
import { patternMatches } from "../src/lib/pattern";
import { themeMatch, loadThemeSectorFilters } from "../src/lib/theme-match";

const DATA = path.join(process.cwd(), "data");
const CANDIDATES_PATH = path.join(DATA, "theme_candidates.json");

type Row = {
  ticker: string;
  name: string;
  text: string;
  sector: string | null;
  sub_sector: string | null;
  about: string | null;
  headquarters: string | null;
};

function loadAboutRows(): Row[] {
  return loadAllCompanies()
    .filter((c) => (c.search_text || c.about || "").trim().length >= 30)
    .map((c) => ({
      ticker: c.ticker,
      name: c.name,
      text: c.search_text,
      sector: c.sector,
      sub_sector: c.sub_sector,
      about: c.about,
      headquarters: c.headquarters,
    }));
}

function parseArgs() {
  const args = process.argv.slice(2);
  let theme: string | null = null;
  let suggest = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--theme" && args[i + 1]) theme = args[++i]!;
    if (args[i] === "--suggest") suggest = true;
  }
  return { theme, suggest };
}

function keywordHits(rows: Row[], keyword: string) {
  const examples: string[] = [];
  let n = 0;
  for (const r of rows) {
    if (!patternMatches(r.text, keyword)) continue;
    n += 1;
    if (examples.length < 3) examples.push(r.ticker);
  }
  return { n, examples };
}

function main() {
  const { theme: onlyTheme, suggest } = parseArgs();
  const rows = loadAboutRows();
  const file = loadThemes();
  const filters = loadThemeSectorFilters();
  const candidates = fs.existsSync(CANDIDATES_PATH)
    ? (JSON.parse(fs.readFileSync(CANDIDATES_PATH, "utf8")) as Record<
        string,
        string[]
      >)
    : {};

  console.log(`About corpus: ${rows.length.toLocaleString()} companies\n`);

  const themes = onlyTheme
    ? file.themes.filter((t) => t.id === onlyTheme)
    : file.themes;

  if (onlyTheme && !themes.length) {
    console.error(`Unknown theme: ${onlyTheme}`);
    process.exit(1);
  }

  for (const t of themes) {
    console.log(`${"=".repeat(60)}\n${t.id} — ${t.name}`);
    const zero: string[] = [];
    const low: string[] = [];
    let themeHits = 0;

    for (const kw of t.keywords) {
      const { n, examples } = keywordHits(rows, kw);
      const tag = n === 0 ? "ZERO" : n < 3 ? "low" : "ok";
      if (n === 0) zero.push(kw);
      else if (n < 3) low.push(kw);
      console.log(`  ${String(n).padStart(4)}  ${kw.padEnd(32)} ${tag}  ${examples.join(", ")}`);
    }

    const gated = rows.filter((r) =>
      themeMatch(
        {
          about: r.about,
          headquarters: r.headquarters,
          search_text: r.text,
          sector: r.sector,
          sub_sector: r.sub_sector,
        },
        t,
        filters,
      ),
    );
    themeHits = gated.length;
    console.log(`\n  Theme matches (keyword + sector gate): ${themeHits}`);
    if (gated.length) {
      console.log(
        `  Sample: ${gated
          .slice(0, 8)
          .map((r) => r.ticker)
          .join(", ")}`,
      );
    }
    if (zero.length) console.log(`  ⚠ zero-hit keywords: ${zero.join(", ")}`);

    if (suggest && candidates[t.id]?.length) {
      console.log("\n  Candidate phrases (not in theme yet):");
      const existing = new Set(t.keywords.map((k) => k.toLowerCase()));
      const ranked: Array<{ c: string; n: number; ex: string[] }> = [];
      for (const c of candidates[t.id]!) {
        if (existing.has(c.toLowerCase())) continue;
        const { n, examples } = keywordHits(rows, c);
        if (n >= 3) ranked.push({ c, n, ex: examples });
      }
      ranked.sort((a, b) => b.n - a.n);
      for (const { c, n, ex } of ranked.slice(0, 8)) {
        console.log(`    ${String(n).padStart(4)}  ${c}  (${ex.join(", ")})`);
      }
    }
    console.log();
  }
}

main();
