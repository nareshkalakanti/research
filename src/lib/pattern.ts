/**
 * Theme / keyword pattern matching.
 * Syntax: `+` = AND, `|` = OR (AND binds tighter).
 * Example: `die casting + auto | EV components`
 *   → (die casting AND auto) OR (EV components)
 *
 * AND terms must each appear as whole words/phrases somewhere in the text
 * (so HQ/location can combine with About). Hits inside financing product
 * phrases (e.g. "rooftop solar loan") are ignored. Bare "nuclear" hits inside
 * "nuclear medicine" / hospital imaging are ignored.
 *
 * Acronyms kept uppercase in the pattern (LED, CTC, BESS) match case-sensitively
 * so "AI-led" does not satisfy LED. Hyphen-suffix hits (`…-led`) are ignored.
 */

export type OrClause = string[]; // AND terms within one OR branch (original casing)

const FINANCE_LOOKAHEAD = 120;
const FINANCE_NOISE =
  /\b(loan|loans|lending|financing|finance|credit|emi|mortgage|nbfc)\b/i;

/** Terms that often false-positive on hospitals / diagnostics. */
const MEDICAL_NOISE_TERMS = new Set([
  "nuclear",
  "isotope",
  "isotopes",
  "radiation",
  "irradiation",
  "cobalt",
  "cobalt-60",
  "radiography",
  "dosimetry",
]);

/** Short uppercase tokens in patterns → case-sensitive match (LED ≠ led). */
function isAcronymTerm(term: string): boolean {
  return /^[A-Z0-9][A-Z0-9.&/-]{1,7}$/.test(term.trim());
}

function financeContext(text: string, start: number, end: number): boolean {
  const span = text.slice(
    Math.max(0, start - 16),
    Math.min(text.length, end + FINANCE_LOOKAHEAD),
  );
  return FINANCE_NOISE.test(span);
}

/** Skip nuclear/radiation hits that are hospital / nuclear-medicine context. */
function medicalNuclearContext(
  text: string,
  start: number,
  end: number,
  term: string,
): boolean {
  if (!MEDICAL_NOISE_TERMS.has(term.toLowerCase())) return false;
  const window = text.slice(
    Math.max(0, start - 24),
    Math.min(text.length, end + 64),
  );
  if (
    /\bnuclear\s+(medicine|imaging|scan|cardiology|diagnostics?)\b/i.test(
      window,
    )
  ) {
    return true;
  }
  if (/\b(pet[\s-]?ct|spect|gamma\s+camera|radiology\s+dept)\b/i.test(window)) {
    return true;
  }
  if (
    term.toLowerCase() === "nuclear" &&
    /^\s*medicine\b/i.test(text.slice(end, end + 24))
  ) {
    return true;
  }
  return false;
}

/** Skip "AI-led", "tech-led", etc. — hyphen makes a compound, not the term. */
function hyphenCompoundContext(text: string, start: number): boolean {
  return start > 0 && text[start - 1] === "-";
}

export function parsePattern(pattern: string): OrClause[] {
  return pattern
    .split("|")
    .map((clause) =>
      clause
        .split("+")
        .map((term) => term.trim())
        .filter(Boolean),
    )
    .filter((clause) => clause.length > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-phrase positions in haystack.
 * Acronym terms (LED, BESS) use case-sensitive search on the original text.
 */
function termPositions(haystack: string, term: string): number[] {
  const raw = term.trim();
  if (!raw) return [];
  const acronym = isAcronymTerm(raw);
  const needle = acronym ? raw : raw.toLowerCase();
  const source = acronym ? haystack : haystack.toLowerCase();
  const re = new RegExp(
    `\\b${escapeRegExp(needle).replace(/\s+/g, "\\s+")}\\b`,
    acronym ? "g" : "gi",
  );
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // Always inspect original casing for hyphen compounds
    if (hyphenCompoundContext(haystack, m.index)) {
      if (m[0].length === 0) re.lastIndex += 1;
      continue;
    }
    // Acronym already case-sensitive; for lowercase "led" also reject if
    // the source span is a hyphen suffix (checked above on haystack).
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
  const lower = haystack.toLowerCase();

  for (const term of clause) {
    const positions = termPositions(haystack, term);
    let ok = false;
    for (const i of positions) {
      const tLow = term.toLowerCase();
      if (financeContext(lower, i, i + term.length)) continue;
      if (medicalNuclearContext(lower, i, i + term.length, tLow)) continue;
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

/** Ticker code match: exact or prefix (TATA → TATAINVEST), not mid-string (atam ↛ DATAMATICS). */
export function tickerMatchesSearch(ticker: string, term: string): boolean {
  const sym = ticker.toLowerCase();
  const t = term.trim().toLowerCase();
  if (!t) return false;
  return sym === t || sym.startsWith(t);
}

/** Whole-word/phrase substring check (avoids "tata" matching "parastatals"). */
export function textHasTerm(haystack: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return termPositions(haystack, t).length > 0;
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

/** Keywords from a highlight list that appear in scraped website text. */
export function scrapeHighlightsForRow(
  scraped: string | null | undefined,
  highlights: string[],
): string[] {
  const text = scraped?.trim() || "";
  if (!text || !highlights.length) return [];
  return matchedKeywords(text, highlights.join(" | "), text);
}

/** Keywords from a highlight list that appear in display About text. */
export function aboutHighlightsForRow(
  about: string | null | undefined,
  highlights: string[],
): string[] {
  const text = about?.trim() || "";
  if (!text || !highlights.length) return [];
  return matchedKeywords(text, highlights.join(" | "), text);
}

/** Whether a matched theme clause hit About, scrape, or both. */
export function matchTagSource(
  term: string,
  about: string | null | undefined,
  scraped: string | null | undefined,
): "about" | "scrape" {
  const t = term.trim();
  if (!t) return "about";
  const a = about?.trim() || "";
  const s = scraped?.trim() || "";
  const inAbout = a ? matchedKeywords(a, t, a).length > 0 : false;
  const inScrape = s ? matchedKeywords(s, t, s).length > 0 : false;
  if (inScrape && !inAbout) return "scrape";
  return "about";
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
  const about = haystack;
  for (const clause of parsePattern(pattern)) {
    if (!clauseMatches(source, clause)) continue;
    for (const term of clause) {
      if (termPositions(about, term).length) found.add(term);
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}
