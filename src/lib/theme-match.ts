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
};

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
