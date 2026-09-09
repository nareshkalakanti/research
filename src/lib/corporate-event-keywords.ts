/**
 * Corporate announcement / event category keywords (from Screener-style tags).
 * Used to label and search concalls, transcripts, and other corporate docs.
 */
import fs from "fs";
import path from "path";

export type CorporateEventKeywordsFile = {
  version: number;
  source: string;
  purpose: string;
  updated_at: string;
  count: number;
  keywords: string[];
  concall_focus: string[];
  families: Record<string, string[]>;
  aliases: Record<string, string[]>;
};

export type CorporateKeywordHit = {
  keyword: string;
  family: string;
  index: number;
};

const DATA_PATH = path.join(
  process.cwd(),
  "data",
  "corporate-event-keywords.json",
);

let cache: CorporateEventKeywordsFile | null = null;

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function loadCorporateEventKeywords(
  opts?: { force?: boolean },
): CorporateEventKeywordsFile {
  if (!opts?.force && cache) return cache;
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  cache = JSON.parse(raw) as CorporateEventKeywordsFile;
  return cache;
}

/** All keywords (1050+). Prefer concallFocusKeywords() for earnings/call scans. */
export function listCorporateEventKeywords(): string[] {
  return loadCorporateEventKeywords().keywords;
}

/** High-signal keywords for concall / earnings / investor-meet search. */
export function concallFocusKeywords(): string[] {
  return loadCorporateEventKeywords().concall_focus;
}

/**
 * Find category keywords that appear in free text (subject, transcript, title).
 * Longer keywords matched first to prefer specific tags.
 */
export function matchCorporateEventKeywords(
  text: string,
  opts?: { focusOnly?: boolean; limit?: number },
): CorporateKeywordHit[] {
  const blob = norm(text);
  if (!blob) return [];
  const lower = blob.toLowerCase();
  const file = loadCorporateEventKeywords();
  const pool = opts?.focusOnly ? file.concall_focus : file.keywords;
  const sorted = [...pool].sort((a, b) => b.length - a.length);
  const hits: CorporateKeywordHit[] = [];
  const seen = new Set<string>();

  for (const kw of sorted) {
    const needle = kw.toLowerCase();
    if (needle.length < 3) continue;
    const idx = lower.indexOf(needle);
    if (idx < 0) continue;
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const family = kw.split(/[/,]/)[0]!.trim() || kw;
    hits.push({ keyword: kw, family, index: idx });
    if (opts?.limit && hits.length >= opts.limit) break;
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** Prefer focus tags, then any corporate-event keyword. */
export function primaryCorporateEventKeyword(
  ...parts: Array<string | null | undefined>
): string | null {
  const blob = parts.filter((p) => (p || "").trim()).join("\n");
  if (!blob.trim()) return null;
  const focus = matchCorporateEventKeywords(blob, {
    focusOnly: true,
    limit: 1,
  });
  if (focus[0]) return focus[0].keyword;
  const any = matchCorporateEventKeywords(blob, { limit: 1 });
  return any[0]?.keyword ?? null;
}

/** True if text looks like an earnings / concall / investor-meet doc. */
export function isConcallLikeDocument(text: string): boolean {
  return matchCorporateEventKeywords(text, { focusOnly: true, limit: 1 })
    .length > 0;
}
