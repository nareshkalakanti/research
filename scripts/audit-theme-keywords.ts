/**
 * Full theme keyword audit (hit rates, zero-hit, loose AND false positives).
 *
 *   npx tsx scripts/audit-theme-keywords.ts
 *   npx tsx scripts/audit-theme-keywords.ts --theme global_rare_earth
 *   npx tsx scripts/audit-theme-keywords.ts --json
 */
import { loadThemes } from "../src/lib/themes";
import {
  auditAllThemes,
  auditTheme,
  formatAuditReport,
  loadAboutRows,
} from "../src/lib/theme-audit";

function parseArgs() {
  const args = process.argv.slice(2);
  let theme: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--theme" && args[i + 1]) theme = args[++i]!;
    if (args[i] === "--json") json = true;
  }
  return { theme, json };
}

function main() {
  const { theme: onlyTheme, json } = parseArgs();
  const rows = loadAboutRows();
  const file = loadThemes();
  const themes = onlyTheme
    ? file.themes.filter((t) => t.id === onlyTheme)
    : file.themes;

  if (onlyTheme && !themes.length) {
    console.error(`Unknown theme: ${onlyTheme}`);
    process.exit(1);
  }

  const audits = onlyTheme
    ? [auditTheme(themes[0]!, rows)]
    : auditAllThemes(themes, rows);

  if (json) {
    console.log(JSON.stringify({ corpus: rows.length, audits }, null, 2));
    return;
  }

  console.log(formatAuditReport(audits, rows.length));
}

main();
