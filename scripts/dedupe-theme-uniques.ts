/**
 * Ensure each keyword and proxy appears in at most one theme (first theme in file order wins).
 *
 *   npx tsx scripts/dedupe-theme-uniques.ts
 *   npx tsx scripts/dedupe-theme-uniques.ts --dry-run
 */
import fs from "fs";
import path from "path";
import { execSync } from "node:child_process";

const MASTER = path.join(process.cwd(), "data", "master_themes.json");

type RawTheme = {
  id: string;
  keywords?: string[];
  keyword_definitions?: Record<string, string>;
  proxies?: string[];
  display_pattern?: string;
  [key: string]: unknown;
};

function normProxy(p: string): string {
  return p
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseArgs() {
  return { dryRun: process.argv.includes("--dry-run") };
}

function main() {
  const { dryRun } = parseArgs();
  const raw = JSON.parse(fs.readFileSync(MASTER, "utf8")) as {
    meta: Record<string, unknown>;
    themes: RawTheme[];
  };

  const claimedKw = new Set<string>();
  const claimedProxy = new Set<string>();
  let kwRemoved = 0;
  let proxyRemoved = 0;

  for (const theme of raw.themes) {
    const beforeKw = theme.keywords?.length ?? 0;
    const beforePx = theme.proxies?.length ?? 0;

    if (Array.isArray(theme.keywords)) {
      const kept: string[] = [];
      for (const kw of theme.keywords) {
        const k = kw.trim();
        if (!k) continue;
        const key = k.toLowerCase();
        if (claimedKw.has(key)) continue;
        claimedKw.add(key);
        kept.push(k);
      }
      theme.keywords = kept;
      kwRemoved += beforeKw - kept.length;

      if (theme.keyword_definitions) {
        const defs: Record<string, string> = {};
        for (const [k, v] of Object.entries(theme.keyword_definitions)) {
          if (kept.some((x) => x.toLowerCase() === k.toLowerCase())) defs[k] = v;
        }
        theme.keyword_definitions = defs;
      }
      delete theme.display_pattern;
    }

    if (Array.isArray(theme.proxies)) {
      const kept: string[] = [];
      for (const p of theme.proxies) {
        const n = normProxy(p);
        if (!n || claimedProxy.has(n)) continue;
        claimedProxy.add(n);
        kept.push(p);
      }
      theme.proxies = kept.length ? kept : undefined;
      proxyRemoved += beforePx - kept.length;
    }
  }

  console.log(
    `${dryRun ? "[dry-run] " : ""}Removed ${kwRemoved} duplicate keywords, ${proxyRemoved} duplicate proxies`,
  );

  if (dryRun) {
    for (const t of raw.themes.filter((x) => x.id.startsWith("themes2026_"))) {
      console.log(
        `  ${t.id}: ${t.keywords?.length ?? 0} kw, ${t.proxies?.length ?? 0} proxies`,
      );
    }
    return;
  }

  raw.meta.deduped_uniques = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(MASTER, `${JSON.stringify(raw, null, 2)}\n`);

  execSync("npx tsx scripts/import-master-themes.ts", {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  execSync("npx tsx scripts/build-theme-sector-filters.ts", {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  execSync("npx tsx scripts/test-themes.ts", { stdio: "inherit", cwd: process.cwd() });
}

main();
