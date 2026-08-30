/**
 * Theme keyword audit — hit rates, gated matches, loose AND false positives.
 */
import { loadAllCompanies } from "./db";
import { patternMatches, parsePattern } from "./pattern";
import { loadThemeSectorFilters, themeMatch } from "./theme-match";
import type { Theme } from "./themes";

export type AboutRow = {
  ticker: string;
  name: string;
  text: string;
  sector: string | null;
  sub_sector: string | null;
  about: string | null;
  headquarters: string | null;
};

export type KeywordAudit = {
  keyword: string;
  hits: number;
  examples: string[];
  gated: number;
  looseAnd: string[];
};

export type ThemeAudit = {
  id: string;
  name: string;
  blog_theme: string;
  keywords: KeywordAudit[];
  zeroHit: string[];
  lowHit: string[];
  gatedMatches: number;
  gatedSample: string[];
  looseAndTickers: string[];
};

const LOOSE_AND_CHARS = 140;

function termPositions(haystack: string, term: string): number[] {
  const raw = term.trim();
  if (!raw) return [];
  const re = new RegExp(
    `\\b${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`,
    "gi",
  );
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    out.push(m.index);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
}

/** True when AND terms match but sit far apart in the same About (document-level false positive). */
export function looseAndMatch(haystack: string, keyword: string): boolean {
  const clauses = parsePattern(keyword);
  if (clauses.length !== 1 || clauses[0]!.length < 2) return false;
  const terms = clauses[0]!;
  const positions = terms.map((t) => termPositions(haystack, t));
  if (positions.some((p) => p.length === 0)) return false;
  let minDist = Infinity;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      for (const a of positions[i]!) {
        for (const b of positions[j]!) {
          minDist = Math.min(minDist, Math.abs(a - b));
        }
      }
    }
  }
  return minDist > LOOSE_AND_CHARS;
}

export function loadAboutRows(): AboutRow[] {
  return loadAllCompanies()
    .filter((c) => (c.theme_search_text || c.about || "").trim().length >= 30)
    .map((c) => ({
      ticker: c.ticker,
      name: c.name,
      text: c.theme_search_text,
      sector: c.sector,
      sub_sector: c.sub_sector,
      about: c.about,
      headquarters: c.headquarters,
    }));
}

export function auditTheme(theme: Theme, rows: AboutRow[]): ThemeAudit {
  const filters = loadThemeSectorFilters();
  const keywords: KeywordAudit[] = [];
  const looseAndTickers = new Set<string>();

  for (const kw of theme.keywords) {
    const examples: string[] = [];
    const loose: string[] = [];
    let hits = 0;
    let gated = 0;

    for (const r of rows) {
      if (!patternMatches(r.text, kw)) continue;
      hits += 1;
      if (examples.length < 3) examples.push(r.ticker);
      if (looseAndMatch(r.text, kw)) {
        loose.push(r.ticker);
        looseAndTickers.add(r.ticker);
      }
      if (
        themeMatch(
          {
            about: r.about,
            headquarters: r.headquarters,
            theme_search_text: r.text,
            sector: r.sector,
            sub_sector: r.sub_sector,
          },
          theme,
          filters,
        )
      ) {
        gated += 1;
      }
    }

    keywords.push({ keyword: kw, hits, examples, gated, looseAnd: loose });
  }

  const gatedRows = rows.filter((r) =>
    themeMatch(
      {
        about: r.about,
        headquarters: r.headquarters,
        theme_search_text: r.text,
        sector: r.sector,
        sub_sector: r.sub_sector,
      },
      theme,
      filters,
    ),
  );

  return {
    id: theme.id,
    name: theme.name,
    blog_theme: theme.blog_theme,
    keywords,
    zeroHit: keywords.filter((k) => k.hits === 0).map((k) => k.keyword),
    lowHit: keywords.filter((k) => k.hits > 0 && k.hits < 3).map((k) => k.keyword),
    gatedMatches: gatedRows.length,
    gatedSample: gatedRows.slice(0, 8).map((r) => r.ticker),
    looseAndTickers: [...looseAndTickers],
  };
}

export function auditAllThemes(themes: Theme[], rows?: AboutRow[]): ThemeAudit[] {
  const corpus = rows ?? loadAboutRows();
  return themes.map((t) => auditTheme(t, corpus));
}

export function formatAuditReport(audits: ThemeAudit[], corpusSize: number): string {
  const lines: string[] = [
    `About corpus: ${corpusSize.toLocaleString()} companies`,
    "",
  ];

  let totalZero = 0;
  for (const a of audits) {
    totalZero += a.zeroHit.length;
    lines.push("=".repeat(60));
    lines.push(`${a.id} — ${a.name}`);
    lines.push(`  Group: ${a.blog_theme}`);
    lines.push(`  Gated matches: ${a.gatedMatches}`);
    if (a.gatedSample.length) lines.push(`  Sample: ${a.gatedSample.join(", ")}`);
    lines.push("");

    for (const k of a.keywords) {
      const tag = k.hits === 0 ? "ZERO" : k.hits < 3 ? "low" : "ok";
      const loose =
        k.looseAnd.length > 0 ? `  loose-AND:${k.looseAnd.slice(0, 3).join(",")}` : "";
      lines.push(
        `  ${String(k.hits).padStart(4)}  ${k.keyword.padEnd(34)} ${tag}  ${k.examples.join(", ")}${loose}`,
      );
    }

    if (a.zeroHit.length) {
      lines.push(`  ⚠ zero-hit (${a.zeroHit.length}): ${a.zeroHit.join(", ")}`);
    }
    if (a.looseAndTickers.length) {
      lines.push(
        `  ⚠ loose AND matches (${a.looseAndTickers.length}): ${a.looseAndTickers.join(", ")}`,
      );
    }
    lines.push("");
  }

  lines.push("=".repeat(60));
  lines.push(
    `Summary: ${audits.length} themes · ${totalZero} zero-hit keywords total · corpus ${corpusSize.toLocaleString()}`,
  );
  return lines.join("\n");
}
