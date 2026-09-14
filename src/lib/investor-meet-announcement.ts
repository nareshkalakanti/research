/**
 * Detect Reg-30 investor / analyst meet & call filings from subject/category text.
 * Client-safe (no fs) — used by MarketIQ topic chip and Research · Analyst.
 */

const EXCLUDE_RE =
  /\binvestor\s+education\b|\biepf\b|\bunclaimed\s+dividend\b|\btransfer\s+of\s+unclaimed\b/i;

/** Category labels that are already meet/call families (not presentations alone). */
const CATEGORY_RE =
  /^(investor\s+meets?|investor\s+meetings?|investors?\s+meets?|investors?\s+meetings?|investor\s+conference|investor\s+call|conference\s+call)\b/i;

const SUBJECT_RE =
  /investors?\s*(?:&|and|\/)\s*analysts?\s*(?:meet(?:ing)?s?|call|conference)|analysts?\s*(?:&|and|\/)\s*investors?\s*(?:meet(?:ing)?s?|call|conference)|institutional\s+investors?\s*meet(?:ing)?s?|investors?\s+meet(?:ing)?s?(?:\s*\/\s*analysts?\s*call)?|investor\s+meet(?:ing)?s?(?:\s*\/\s*analysts?\s*call)?|analysts?\s*(?:\/\s*institutional\s+investor\s*)?meet(?:ing)?s?|analysts?\s+call|investor\s+call|investor\s+conference\s+call|con\.?\s*call\s+updates|schedule\s+of\s+(?:the\s+)?(?:analyst|investor)/i;

/** True for investor/analyst meet & call schedule (and related) announcements. */
export function isInvestorAnalystMeetAnnouncement(
  ...parts: Array<string | null | undefined>
): boolean {
  const blob = parts
    .map((p) => (p || "").trim())
    .filter(Boolean)
    .join("\n");
  if (!blob) return false;

  const category = (parts[0] || "").trim();
  if (category && CATEGORY_RE.test(category)) return true;

  if (EXCLUDE_RE.test(blob) && !SUBJECT_RE.test(blob)) return false;
  return SUBJECT_RE.test(blob);
}

/** Letter boilerplate / confirms — never investor names. */
const NOISE_NAME =
  /^(sl\.?\s*no\.?|name of the institutional investor|annexure|thanking you|yours truly|we hereby|we wish|for\s+[a-z]|confidential|page\s+\d+|the interactions were|no presentation was|no unpublished|upsi|q\s*&\s*a format|made by the kmp)/i;

const ENTITY_HINT =
  /mutual\s+fund|insurance|asset\s+management|investment|capital|portfolio|wealth|invest|ventures|manager|fund|limited|ltd\.?|pvt\.?|private|amc|advisors?/i;

function collectEntityRows(body: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const row = line.match(/^\s*(\d{1,3})\.\s+(.+)$/);
    if (!row?.[2]) continue;
    const name = row[2].replace(/\s+/g, " ").trim();
    if (name.length < 4 || name.length > 160) continue;
    if (NOISE_NAME.test(name)) continue;
    if (!ENTITY_HINT.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * Parse annexure table of institutional investors from filing text.
 * Only rows under "Name of the Institutional Investor" / Annexure — not Q&A confirms.
 * Names come from the PDF only — no hardcoded fund list.
 */
export function parseInstitutionalInvestors(text: string): string[] {
  if (!text?.trim()) return [];

  type Block = { from: number; names: string[] };
  const blocks: Block[] = [];

  // Strict headers only — do NOT match prose "institutional investors' meeting"
  const headerRe =
    /(?:Sl\.?\s*No\.?\s*)?Name of the Institutional Investor|List of (?:the )?Institutional Investors(?:\s+who\s+attended)?/gi;

  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) {
    const from = m.index + m[0].length;
    const chunk = text.slice(from, from + 14_000);
    const end = chunk.search(
      /\n\s*(?:We\s+wish|We\s+hereby|Thanking you|Yours truly|For\s+[A-Z][a-z]|Subject\s*:|Notes?\s*:)/i,
    );
    const body = end > 40 ? chunk.slice(0, end) : chunk;
    const blockNames = collectEntityRows(body);
    if (blockNames.length) blocks.push({ from: m.index, names: blockNames });
  }

  // Annexure section with numbered entity rows (when table header OCR is weak)
  const annexRe = /\bAnnexure\b/gi;
  while ((m = annexRe.exec(text)) !== null) {
    const chunk = text.slice(m.index, m.index + 14_000);
    const blockNames = collectEntityRows(chunk);
    if (blockNames.length >= 3) {
      blocks.push({ from: m.index, names: blockNames });
    }
  }

  if (blocks.length) {
    // Prefer the longest block (full annexure over a truncated mash-up)
    blocks.sort((a, b) => b.names.length - a.names.length || b.from - a.from);
    return blocks[0]!.names;
  }

  // Last resort: numbered entity rows only (Q&A filtered by ENTITY_HINT + NOISE)
  return collectEntityRows(text);
}
