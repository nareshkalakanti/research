/**
 * Theme / keyword pattern matching.
 * Syntax: `+` = AND, `|` = OR (AND binds tighter).
 * Example: `die casting + auto | EV components`
 *   → (die casting AND auto) OR (EV components)
 *
 * AND terms must each appear as whole words/phrases somewhere in the text
 * (so HQ/location can combine with About). Hits inside financing product
 * phrases (e.g. "rooftop solar loan") are ignored.
 */

export type OrClause = string[]; // AND terms within one OR branch

const FINANCE_LOOKAHEAD = 120;
const FINANCE_NOISE =
  /\b(loan|loans|lending|financing|finance|credit|emi|mortgage|nbfc)\b/i;

function financeContext(text: string, start: number, end: number): boolean {
  const span = text.slice(
    Math.max(0, start - 16),
    Math.min(text.length, end + FINANCE_LOOKAHEAD),
  );
  return FINANCE_NOISE.test(span);
}

export function parsePattern(pattern: string): OrClause[] {
  return pattern
    .split("|")
    .map((clause) =>
      clause
        .split("+")
        .map((term) => term.trim().toLowerCase())
        .filter(Boolean),
    )
    .filter((clause) => clause.length > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-phrase positions (case-insensitive) in haystack. */
function termPositions(haystack: string, term: string): number[] {
  const re = new RegExp(
    `\\b${escapeRegExp(term).replace(/\s+/g, "\\s+")}\\b`,
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

/**
 * True when every AND term appears as a whole phrase in the document.
 * (Document-level AND so HQ/location can combine with About terms.)
 */
export function clauseMatches(haystack: string, clause: OrClause): boolean {
  if (clause.length === 0) return false;
  const text = haystack.toLowerCase();

  for (const term of clause) {
    const positions = termPositions(text, term);
    let ok = false;
    for (const i of positions) {
      if (financeContext(text, i, i + term.length)) continue;
      ok = true;
      break;
    }
    if (!ok) return false;
  }
  return true;
}

export function patternMatches(haystack: string, pattern: string): boolean {
  const clauses = parsePattern(pattern);
  if (clauses.length === 0) return false;
  return clauses.some((clause) => clauseMatches(haystack, clause));
}

/** Whole-word/phrase substring check (avoids "tata" matching "parastatals"). */
export function textHasTerm(haystack: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  return termPositions(haystack.toLowerCase(), t).length > 0;
}

/** Combine selected theme patterns + custom input into one OR of clauses. */
export function combinePatterns(patterns: string[]): string {
  return patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" | ");
}

export function matchedTerms(haystack: string, pattern: string): string[] {
  const found = new Set<string>();
  for (const clause of parsePattern(pattern)) {
    if (clauseMatches(haystack, clause)) {
      found.add(clause.join(" + "));
    }
  }
  return [...found];
}

/** Individual keyword phrases found in text (for About highlighting). */
export function matchedKeywords(
  haystack: string,
  pattern: string,
  /**
   * Text used to decide which OR clauses matched (e.g. full search_text).
   * Terms are still only collected when they appear in ``haystack`` (About).
   */
  matchSource?: string,
): string[] {
  const found = new Set<string>();
  const source = matchSource ?? haystack;
  const about = haystack.toLowerCase();
  for (const clause of parsePattern(pattern)) {
    if (!clauseMatches(source, clause)) continue;
    for (const term of clause) {
      if (termPositions(about, term).length) found.add(term);
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}
