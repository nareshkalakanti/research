/**
 * Theme match = keyword pattern AND sector/sub-sector gate.
 * Filters live in data/theme_sector_filters.json.
 */
import fs from "fs";
import path from "path";
import { mergeAboutSourcesForThemeSearch } from "./db";
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
  yf_about?: string | null;
  scraped_about?: string | null;
  headquarters?: string | null;
  search_text?: string | null;
  theme_search_text?: string | null;
  sector?: string | null;
  sub_sector?: string | null;
  mcap_cr?: number | null;
};

/** Keyword corpus: About + Yahoo + optional LLM-cleaned website summary. */
export function themeSearchCorpus(row: ThemeMatchRow): string {
  const themeText = row.theme_search_text?.trim();
  if (themeText) return themeText;

  const merged = mergeAboutSourcesForThemeSearch({
    about: row.about ?? null,
    yf_about: row.yf_about ?? null,
  });
  const fallback = [row.headquarters, merged, row.about]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join("\n");
  return fallback;
}

/** Legacy blog-group caps (older theme files). Per-theme caps live in theme_keywords.json meta. */
export const BLOG_THEME_MAX_MCAP_CR: Record<string, number> = {
  "Nanocap Champs": 500,
  "Listed Venture Capital": 6000,
};

const DATA_DIR = path.join(process.cwd(), "data");
const THEME_KEYWORDS_PATH = path.join(DATA_DIR, "theme_keywords.json");

let themeMaxMcapCache: Record<string, number> | null = null;

/** Per-theme id and legacy blog_theme max mcap (₹ Cr) from theme_keywords.json meta. */
export function loadThemeMaxMcapCr(): Record<string, number> {
  if (themeMaxMcapCache) return themeMaxMcapCache;
  const out: Record<string, number> = { ...BLOG_THEME_MAX_MCAP_CR };
  if (fs.existsSync(THEME_KEYWORDS_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(THEME_KEYWORDS_PATH, "utf8")) as {
        meta?: { theme_max_mcap_cr?: Record<string, number> };
      };
      const perTheme = raw.meta?.theme_max_mcap_cr;
      if (perTheme && typeof perTheme === "object") {
        for (const [id, cap] of Object.entries(perTheme)) {
          if (typeof cap === "number" && cap > 0) out[id] = cap;
        }
      }
    } catch {
      /* keep defaults */
    }
  }
  themeMaxMcapCache = out;
  return out;
}

export function invalidateThemeMaxMcapCache(): void {
  themeMaxMcapCache = null;
}

function themeCapPasses(
  theme: Theme,
  mcap: number | null | undefined,
): boolean {
  const map = loadThemeMaxMcapCr();
  const max = map[theme.id] ?? map[theme.blog_theme];
  if (max == null) return true;
  if (mcap == null) return true;
  return mcap <= max;
}

const FILTER_PATH = path.join(DATA_DIR, "theme_sector_filters.json");
const RESEARCH_PATTERN_PATH = path.join(DATA_DIR, "theme_research_patterns.json");

let researchPatternCache: Record<string, string> | null = null;

/** Site/news terms appended for matching (often absent from Screener About). */
export function loadThemeResearchPatterns(): Record<string, string> {
  if (researchPatternCache) return researchPatternCache;
  researchPatternCache = {};
  if (!fs.existsSync(RESEARCH_PATTERN_PATH)) return researchPatternCache;
  try {
    const raw = JSON.parse(fs.readFileSync(RESEARCH_PATTERN_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    for (const [id, pat] of Object.entries(raw)) {
      if (id === "meta" || typeof pat !== "string") continue;
      const s = pat.trim();
      if (s) researchPatternCache[id] = s;
    }
  } catch {
    researchPatternCache = {};
  }
  return researchPatternCache;
}

/** Theme OR-clauses + optional research/site keyword extensions. */
export function themeMatchPattern(theme: Theme): string {
  const extra = loadThemeResearchPatterns()[theme.id]?.trim();
  if (!extra) return theme.display_pattern;
  return `${theme.display_pattern} | ${extra}`;
}

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
  const text = themeSearchCorpus(row);
  if (!text || !patternMatches(text, themeMatchPattern(theme))) return false;
  if (!themeCapPasses(theme, row.mcap_cr)) return false;
  const map = filters ?? loadThemeSectorFilters();
  return sectorGatePasses(row, map[theme.id]);
}

/**
 * Match selected themes and optional custom keywords.
 * Themes are OR'd with each other (each still has its sector gate).
 * When both themes and custom are set, custom **narrows** (AND) — it does not
 * bypass theme/sector filters (avoids e.g. "transformer oil" pulling chemicals
 * into an offshore E&P theme).
 */
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
  const search = themeSearchCorpus(row);
  const matchedThemeIds: string[] = [];
  const termSet = new Set<string>();
  const highlightSet = new Set<string>();
  const patterns: string[] = [];

  for (const theme of themes) {
    const pattern = themeMatchPattern(theme);
    patterns.push(pattern);
    if (!themeMatch(row, theme, filters)) continue;
    matchedThemeIds.push(theme.id);
    for (const t of matchedTerms(search, pattern)) termSet.add(t);
    for (const h of matchedKeywords(search, pattern, search)) {
      highlightSet.add(h);
    }
  }

  const custom = opts?.customPattern?.trim() || "";
  let customHit = false;
  if (custom) {
    patterns.push(custom);
    if (search && patternMatches(search, custom)) {
      customHit = true;
      for (const t of matchedTerms(search, custom)) termSet.add(t);
      for (const h of matchedKeywords(search, custom, search)) {
        highlightSet.add(h);
      }
    }
  }

  const hasThemes = themes.length > 0;
  const matched = hasThemes
    ? matchedThemeIds.length > 0 && (!custom || customHit)
    : customHit;

  return {
    matched,
    matchedThemeIds,
    matchedTerms: matched ? [...termSet] : [],
    highlights: matched
      ? [...highlightSet].sort((a, b) => b.length - a.length)
      : [],
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
    matchedThemeIdsByTicker?: Record<string, string[]>;
    highlightsByTicker: Record<string, string[]>;
    fullHighlightsByTicker?: Record<string, string[]>;
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
    if (opts.matchedThemeIdsByTicker) {
      opts.matchedThemeIdsByTicker[c.ticker] = result.matchedThemeIds;
    }
    if (opts.fullHighlightsByTicker) {
      opts.fullHighlightsByTicker[c.ticker] = result.highlights;
    }
    have.add(t);
  }
  return out;
}
