import fs from "fs";
import path from "path";

export type Theme = {
  id: string;
  name: string;
  blog_theme: string;
  display_pattern: string;
  keywords: string[];
  keyword_definitions?: Record<string, string>;
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
    return {
      id: String(t.id),
      name: String(t.name),
      blog_theme: String(t.blog_theme ?? "Other"),
      display_pattern,
      keywords,
      keyword_definitions:
        t.keyword_definitions &&
        typeof t.keyword_definitions === "object" &&
        !Array.isArray(t.keyword_definitions)
          ? (t.keyword_definitions as Record<string, string>)
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
    themes: group,
  }));
}

export function themesByIds(ids: string[]): Theme[] {
  const set = new Set(ids);
  return loadThemes().themes.filter((t) => set.has(t.id));
}
