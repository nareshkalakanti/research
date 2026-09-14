/**
 * MarketIQ fund-name catalog (data/marketiq-fund-aliases.json).
 * Generic contains-match → short alias chips. Client-safe (bundled JSON).
 */
import catalog from "../../data/marketiq-fund-aliases.json";

export type MarketIqFundAliasEntry = {
  name: string;
  alias: string;
  chip_key: string;
};

export type MarketIqFundMention = {
  name: string;
  alias: string;
  chip_key: string;
};

type CatalogFile = { funds: MarketIqFundAliasEntry[] };

const FUNDS: MarketIqFundAliasEntry[] = (
  catalog as CatalogFile
).funds.filter((f) => f?.name?.trim() && f?.alias?.trim() && f?.chip_key?.trim());

/** Normalize for contains matching (case/punct/spacing tolerant). */
export function normalizeFundMatchText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Catalog entries longest-first (prefer specific product names). */
export function listMarketIqFundAliasCatalog(): MarketIqFundAliasEntry[] {
  return [...FUNDS].sort((a, b) => b.name.length - a.name.length);
}

/** Contains-match with soft word boundaries for short single-token needles. */
function haystackHasFundNeedle(haystack: string, needle: string): boolean {
  if (!needle || needle.length < 3) return false;
  if (needle.includes(" ") || needle.length >= 8) {
    return haystack.includes(needle);
  }
  return (
    haystack === needle ||
    haystack.startsWith(`${needle} `) ||
    haystack.endsWith(` ${needle}`) ||
    haystack.includes(` ${needle} `)
  );
}

/**
 * Find catalog fund names/aliases contained in text (or any of the extra haystacks).
 * Dedupes by chip_key (one chip per fund family).
 * Prefers a full-name hit over a shared-alias hit so the chip title matches the filing.
 */
export function matchMarketIqFundsInText(
  text: string,
  extraHaystacks: string[] = [],
): MarketIqFundMention[] {
  const parts = [text, ...extraHaystacks]
    .map((p) => (p || "").trim())
    .filter(Boolean);
  if (!parts.length) return [];

  const haystack = normalizeFundMatchText(parts.join("\n"));
  if (!haystack) return [];

  const seen = new Set<string>();
  const out: MarketIqFundMention[] = [];

  const push = (entry: MarketIqFundAliasEntry) => {
    const key = entry.chip_key.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      name: entry.name,
      alias: entry.alias.trim(),
      chip_key: key,
    });
  };

  // Pass 1: full legal/product names (longest first)
  for (const entry of listMarketIqFundAliasCatalog()) {
    const nameNeedle = normalizeFundMatchText(entry.name);
    if (nameNeedle.length >= 4 && haystackHasFundNeedle(haystack, nameNeedle)) {
      push(entry);
    }
  }

  // Pass 2: short aliases for chip_keys not already claimed
  for (const entry of listMarketIqFundAliasCatalog()) {
    const key = entry.chip_key.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    const aliasNeedle = normalizeFundMatchText(entry.alias);
    if (
      aliasNeedle.length >= 4 &&
      haystackHasFundNeedle(haystack, aliasNeedle)
    ) {
      push(entry);
    }
  }

  return out.sort((a, b) =>
    a.alias.localeCompare(b.alias, undefined, { sensitivity: "base" }),
  );
}

/**
 * Split text into plain / highlight segments for matched fund full names.
 * Case-insensitive; longest names first to avoid nested overlaps.
 */
export function highlightMarketIqFundSegments(
  text: string,
  mentions: MarketIqFundMention[],
): Array<{ text: string; hit: boolean; chip_key?: string }> {
  if (!text) return [];
  if (!mentions.length) return [{ text, hit: false }];

  const needles = [...mentions]
    .flatMap((m) => {
      const labels = [m.name, m.alias]
        .map((s) => (s || "").trim())
        .filter(Boolean);
      const uniq = [...new Set(labels.map((s) => s.toLowerCase()))].map(
        (low) => labels.find((s) => s.toLowerCase() === low)!,
      );
      return uniq.map((label) => ({
        name: label,
        chip_key: m.chip_key,
        re: new RegExp(
          label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
          "gi",
        ),
      }));
    })
    .sort((a, b) => b.name.length - a.name.length);

  type Mark = { start: number; end: number; chip_key: string };
  const marks: Mark[] = [];
  for (const n of needles) {
    n.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = n.re.exec(text)) != null) {
      const start = m.index;
      const end = start + m[0].length;
      if (marks.some((x) => !(end <= x.start || start >= x.end))) continue;
      marks.push({ start, end, chip_key: n.chip_key });
      if (!n.re.global) break;
    }
  }
  marks.sort((a, b) => a.start - b.start);

  const segs: Array<{ text: string; hit: boolean; chip_key?: string }> = [];
  let cursor = 0;
  for (const mk of marks) {
    if (mk.start > cursor) {
      segs.push({ text: text.slice(cursor, mk.start), hit: false });
    }
    segs.push({
      text: text.slice(mk.start, mk.end),
      hit: true,
      chip_key: mk.chip_key,
    });
    cursor = mk.end;
  }
  if (cursor < text.length) segs.push({ text: text.slice(cursor), hit: false });
  return segs.length ? segs : [{ text, hit: false }];
}
