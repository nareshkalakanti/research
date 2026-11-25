import { openSqliteNamed } from "./sqlite-utils";

/**
 * AI-extracted company fields sometimes hold "not specified in the text" style
 * placeholders, or a template line shared word-for-word by many companies
 * ("Engaged in core industry operations, manufacturing, and services"). Neither
 * says anything about the company, so the About card hides them.
 */

const PLACEHOLDER =
  /\bnot (specified|mentioned|available|provided|stated|given|disclosed|explicitly (stated|mentioned|specified))\b|\bno information\b|\b(in|from) the (given |provided |above )?text\b|^\s*(n\/?a|na|unknown|none|null|-+)\s*\.?\s*$/i;

export function isPlaceholderText(s: string | null | undefined): boolean {
  return !!s && PLACEHOLDER.test(s);
}

/** The text, or null when empty or a placeholder. */
export function cleanAboutText(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t && !isPlaceholderText(t) ? t : null;
}

/** A headline shared by this many companies is a template, not a description. */
const BOILERPLATE_MIN = 5;
let boiler: { at: number; set: Set<string> } | null = null;

function boilerplateHeadlines(): Set<string> {
  if (boiler && Date.now() - boiler.at < 10 * 60_000) return boiler.set;
  const set = new Set<string>();
  try {
    const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
    try {
      for (const r of db
        .prepare(
          `SELECT LOWER(TRIM(business_model)) AS b FROM company_about
           WHERE business_model IS NOT NULL AND TRIM(business_model) <> ''
           GROUP BY b HAVING COUNT(*) >= ?`,
        )
        .all(BOILERPLATE_MIN) as Array<{ b: string }>)
        set.add(normHeadline(r.b));
    } finally {
      db.close();
    }
  } catch {
    /* no table */
  }
  boiler = { at: Date.now(), set };
  return set;
}

const normHeadline = (s: string) => s.toLowerCase().trim().replace(/[.\s]+$/, "");

/** Business-model headline worth showing: not a placeholder, not a shared template. */
export function cleanHeadline(s: string | null | undefined): string | null {
  const t = cleanAboutText(s);
  if (!t) return null;
  return boilerplateHeadlines().has(normHeadline(t)) ? null : t;
}
