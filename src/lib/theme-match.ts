/**
 * Theme match = keyword pattern AND sector/sub-sector gate.
 * Filters live in data/theme_sector_filters.json.
 */
import fs from "fs";
import path from "path";
import { matchedKeywords, matchedTerms, patternMatches } from "./pattern";
import type { Theme } from "./themes";

export type ThemeSectorFilter = {
  allow_sectors?: string[];
  allow_subsectors?: string[];
  exclude_pairs?: string[];
};

export type ThemeFilterFile = {
  meta?: Record<string, unknown>;
  filters: Record<string, ThemeSectorFilter>;
};

export type ThemeMatchRow = {
  about?: string | null;
  headquarters?: string | null;
  search_text?: string | null;
  sector?: string | null;
  sub_sector?: string | null;
  mcap_cr?: number | null;
};

/** Max mcap (₹ Cr) by newsletter group — tightens Nanocap / LVC to investable size. */
export const BLOG_THEME_MAX_MCAP_CR: Record<string, number> = {
  "Nanocap Champs": 500,
  "Listed Venture Capital": 6000,
};

function blogCapPasses(
  blogTheme: string,
  mcap: number | null | undefined,
): boolean {
  const max = BLOG_THEME_MAX_MCAP_CR[blogTheme];
  if (max == null) return true;
  if (mcap == null) return true;
  return mcap <= max;
}

const DATA_DIR = path.join(process.cwd(), "data");
const FILTER_PATH = path.join(DATA_DIR, "theme_sector_filters.json");

let cache: { at: number; filters: Record<string, ThemeSectorFilter> } | null =
  null;
const CACHE_MS = 15_000;

export function loadThemeSectorFilters(): Record<string, ThemeSectorFilter> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.filters;
  if (!fs.existsSync(FILTER_PATH)) {
    cache = { at: now, filters: {} };
    return cache.filters;
  }
  const raw = JSON.parse(fs.readFileSync(FILTER_PATH, "utf8")) as ThemeFilterFile;
  const filters = raw.filters ?? {};
  cache = { at: now, filters };
  return filters;
}

export function invalidateThemeSectorFilterCache(): void {
  cache = null;
}

function sectorPair(
  sector: string | null | undefined,
  subSector: string | null | undefined,
): string {
  return `${(sector || "").trim()} > ${(subSector || "").trim()}`;
}

/** True when filter has any allow list (gate is active). */
export function filterIsActive(f: ThemeSectorFilter | undefined): boolean {
  if (!f) return false;
  return (
    (f.allow_sectors?.length ?? 0) > 0 || (f.allow_subsectors?.length ?? 0) > 0
  );
}

/**
 * Sector/sub-sector gate after keyword match.
 * No filter / empty allows → pass (keyword-only).
 */
export function sectorGatePasses(
  row: ThemeMatchRow,
  filter: ThemeSectorFilter | undefined,
): boolean {
  if (!filterIsActive(filter)) return true;
  const f = filter!;
  const sector = row.sector?.trim() || "";
  const sub = row.sub_sector?.trim() || "";
  const pair = sectorPair(sector, sub);

  if (f.exclude_pairs?.includes(pair)) return false;
  if (sub && f.allow_subsectors?.includes(sub)) return true;
  if (sector && f.allow_sectors?.includes(sector)) return true;
  return false;
}

export function themeMatch(
  row: ThemeMatchRow,
  theme: Theme,
  filters?: Record<string, ThemeSectorFilter>,
): boolean {
  const text =
    row.search_text?.trim() ||
    [row.about, row.headquarters].filter(Boolean).join("\n");
  if (!text || !patternMatches(text, theme.display_pattern)) return false;
  if (!blogCapPasses(theme.blog_theme, row.mcap_cr)) return false;
  const map = filters ?? loadThemeSectorFilters();
  return sectorGatePasses(row, map[theme.id]);
}

/** OR across selected themes (+ optional custom keyword pattern). */
export function matchThemesForRow(
  row: ThemeMatchRow,
  themes: Theme[],
  opts?: {
    customPattern?: string | null;
    filters?: Record<string, ThemeSectorFilter>;
  },
): {
  matched: boolean;
  matchedThemeIds: string[];
  matchedTerms: string[];
  highlights: string[];
  scanPattern: string;
} {
  const filters = opts?.filters ?? loadThemeSectorFilters();
  const search =
    row.search_text?.trim() ||
    [row.about, row.headquarters].filter(Boolean).join("\n");
  const about = [row.about, row.headquarters].filter(Boolean).join("\n");
  const matchedThemeIds: string[] = [];
  const termSet = new Set<string>();
  const highlightSet = new Set<string>();
  const patterns: string[] = [];

  for (const theme of themes) {
    patterns.push(theme.display_pattern);
    if (!themeMatch(row, theme, filters)) continue;
    matchedThemeIds.push(theme.id);
    for (const t of matchedTerms(search, theme.display_pattern)) termSet.add(t);
    for (const h of matchedKeywords(about, theme.display_pattern, search)) {
      highlightSet.add(h);
    }
  }

  const custom = opts?.customPattern?.trim() || "";
  if (custom) {
    patterns.push(custom);
    if (search && patternMatches(search, custom)) {
      matchedThemeIds.push("__custom__");
      for (const t of matchedTerms(search, custom)) termSet.add(t);
      for (const h of matchedKeywords(about, custom, search)) highlightSet.add(h);
    }
  }

  return {
    matched: matchedThemeIds.length > 0,
    matchedThemeIds: matchedThemeIds.filter((id) => id !== "__custom__"),
    matchedTerms: [...termSet],
    highlights: [...highlightSet].sort((a, b) => b.length - a.length),
    scanPattern: patterns.filter(Boolean).join(" | "),
  };
}

/** Keep portfolio names that match the active theme scan in the result set. */
export function mergeThemePortfolioRows<
  T extends ThemeMatchRow & { ticker: string },
>(
  rows: T[],
  universe: T[],
  themes: Theme[],
  opts: {
    customPattern?: string | null;
    holdings: Set<string>;
    matchedByTheme: Record<string, string[]>;
    highlightsByTicker: Record<string, string[]>;
  },
): T[] {
  if (!themes.length && !opts.customPattern?.trim()) return rows;
  const have = new Set(rows.map((c) => c.ticker.toUpperCase()));
  const out = [...rows];
  for (const c of universe) {
    const t = c.ticker.toUpperCase();
    if (!opts.holdings.has(t) || have.has(t)) continue;
    const result = matchThemesForRow(c, themes, {
      customPattern: opts.customPattern?.trim() || null,
    });
    if (!result.matched) continue;
    out.push(c);
    opts.matchedByTheme[c.ticker] = result.matchedTerms;
    opts.highlightsByTicker[c.ticker] = result.highlights;
    have.add(t);
  }
  return out;
}
