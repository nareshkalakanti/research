/**
 * Theme / keyword pattern matching.
 * Syntax: `+` = AND, `|` = OR (AND binds tighter).
 * Example: `die casting + auto | EV components`
 *   → (die casting AND auto) OR (EV components)
 *
 * AND terms must appear as whole words/phrases near each other.
 * Hits inside financing product phrases (e.g. "rooftop solar loan") are ignored.
 */

export type OrClause = string[]; // AND terms within one OR branch

const PROXIMITY = 48; // max chars between first & last AND term
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
 * True when every AND term appears nearby as a whole phrase,
 * and the match span is not a financing-product blurb.
 */
export function clauseMatches(haystack: string, clause: OrClause): boolean {
  if (clause.length === 0) return false;
  const text = haystack.toLowerCase();

  if (clause.length === 1) {
    const term = clause[0];
    const positions = termPositions(text, term);
    for (const i of positions) {
      if (financeContext(text, i, i + term.length)) continue;
      return true;
    }
    return false;
  }

  const posLists = clause.map((t) => termPositions(text, t));
  if (posLists.some((p) => p.length === 0)) return false;

  // Check combinations for proximity (bounded — terms are few)
  function search(depth: number, chosen: number[]): boolean {
    if (depth === clause.length) {
      const start = Math.min(...chosen);
      const end =
        Math.max(
          ...chosen.map((p, i) => p + clause[i].length),
        );
      if (end - start > PROXIMITY) return false;
      if (financeContext(text, start, end)) return false;
      return true;
    }
    for (const p of posLists[depth]) {
      if (search(depth + 1, [...chosen, p])) return true;
    }
    return false;
  }

  return search(0, []);
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
