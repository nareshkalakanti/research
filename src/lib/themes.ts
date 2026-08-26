import fs from "fs";
import path from "path";

export type Theme = {
  id: string;
  name: string;
  /** Short chip label for company rows (e.g. "EV / green mobility"). */
  tag?: string;
  /** Optional highlight chip in the theme picker (e.g. "2026"). */
  badge?: string;
  blog_theme: string;
  cluster?: string;
  display_pattern: string;
  keywords: string[];
  keyword_definitions?: Record<string, string>;
  proxies?: string[];
};

export type ThemeFile = {
  meta: {
    source_blog?: string;
    syntax?: string;
    updated?: string;
    [key: string]: unknown;
  };
  themes: Theme[];
};

export type ThemeGroup = {
  blog_theme: string;
  themes: Theme[];
};

const DATA_DIR = path.join(process.cwd(), "data");

export function loadThemes(): ThemeFile {
  const preferred = path.join(DATA_DIR, "theme_keywords.json");
  const fallback = path.join(DATA_DIR, "themes.json");
  const file = fs.existsSync(preferred) ? preferred : fallback;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    meta: ThemeFile["meta"];
    themes: Array<Record<string, unknown>>;
  };

  const themes: Theme[] = raw.themes.map((t) => {
    const display_pattern = String(
      t.display_pattern ?? t.pattern ?? "",
    ).trim();
    const keywords = Array.isArray(t.keywords)
      ? (t.keywords as string[])
      : display_pattern
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean);
    const defsRaw =
      t.keyword_definitions ?? t.definitions ?? t.keywordDefinitions;
    const keyword_definitions =
      defsRaw &&
      typeof defsRaw === "object" &&
      !Array.isArray(defsRaw)
        ? (defsRaw as Record<string, string>)
        : undefined;

    return {
      id: String(t.id),
      name: String(t.name),
      tag: t.tag ? String(t.tag) : undefined,
      badge: t.badge ? String(t.badge) : undefined,
      blog_theme: String(t.blog_theme ?? "Other"),
      cluster: t.cluster ? String(t.cluster) : undefined,
      display_pattern,
      keywords,
      keyword_definitions,
      proxies: Array.isArray(t.proxies)
        ? (t.proxies as string[])
        : undefined,
    };
  });

  return { meta: raw.meta ?? {}, themes };
}

export function groupThemesByBlog(themes: Theme[]): ThemeGroup[] {
  const map = new Map<string, Theme[]>();
  for (const theme of themes) {
    const key = theme.blog_theme || "Other";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(theme);
  }
  return [...map.entries()].map(([blog_theme, group]) => ({
    blog_theme,
    // Highlighted / badge themes first within each group
    themes: [...group].sort((a, b) => {
      const ab = a.badge ? 0 : 1;
      const bb = b.badge ? 0 : 1;
      if (ab !== bb) return ab - bb;
      return (a.tag || a.name).localeCompare(b.tag || b.name);
    }),
  }));
}

export function themesByIds(ids: string[]): Theme[] {
  const set = new Set(ids);
  return loadThemes().themes.filter((t) => set.has(t.id));
}
