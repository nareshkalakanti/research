/**
 * Drop website-extract / LLM-clean fields that describe a different business
 * than listing About (Screener / Yahoo). Generic overlap — no issuer cases.
 */

const STOP = new Set(
  `
    about across after also another based business company companies
    corporate customer customers digital enabled from group india indian
    industry limited ltd manufacturing market markets more other over
    private provides providing public sector services solutions that the
    their them they this through under which with within year years
  `
    .trim()
    .split(/\s+/),
);

export function listingAboutCorpus(row: {
  about?: string | null;
  yf_about?: string | null;
}): string {
  return [row.about, row.yf_about]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length >= 40)
    .join("\n\n");
}

export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  const m = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  for (const w of m) {
    if (STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

/** True when extract barely shares content words with listing About. */
export function extractConflictsWithListing(
  listing: string,
  extract: string | null | undefined,
): boolean {
  const blob = (extract ?? "").trim();
  if (listing.trim().length < 80 || blob.length < 40) return false;
  const L = contentTokens(listing);
  const E = contentTokens(blob);
  if (L.size < 8 || E.size < 3) return false;
  let eInL = 0;
  for (const t of E) if (L.has(t)) eInL += 1;
  let lInE = 0;
  for (const t of L) if (E.has(t)) lInE += 1;
  const extractSupport = eInL / E.size;
  const listingSupport = lInE / L.size;
  return extractSupport < 0.14 && listingSupport < 0.14;
}

export function dropIfConflictsListing(
  listing: string,
  extract: string | null | undefined,
): string | null {
  const t = (extract ?? "").trim();
  if (!t) return null;
  if (extractConflictsWithListing(listing, t)) return null;
  return t;
}

export function phraseGroundedInListing(
  listing: string,
  phrase: string,
): boolean {
  const t = phrase.trim().toLowerCase();
  if (!t || listing.trim().length < 40) return true;
  const L = listing.toLowerCase();
  if (L.includes(t)) return true;
  const parts = t
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 3 && !STOP.has(p));
  if (!parts.length) return false;
  const listingToks = contentTokens(listing);
  return parts.some((p) => listingToks.has(p) || L.includes(p));
}

const QTR_IN_HEADLINE =
  /\b(?:with\s+)?(?:inconsistent|growing|declining|lumpy|uneven)\s+(?:sales|revenue|results?|quarters?)\b/gi;

/** Headline is the business — quarterly trend lives on the QTR row. */
export function stripQuarterlyFromHeadline(headline: string): string {
  return headline
    .replace(QTR_IN_HEADLINE, " ")
    .replace(/^\s*[,;:|/—–-]+|[ ,;:|/—–-]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const COARSE_HEADLINE_WORDS = new Set([
  "steel",
  "iron",
  "metal",
  "metals",
  "manufacturer",
  "manufacturing",
  "producer",
  "products",
  "product",
  "maker",
]);

/**
 * Prefer a listing-grounded business-model line when the LLM headline is only
 * a coarse sector label (and never keep quarterly sales in the headline).
 */
export function preferSpecificHeadline(opts: {
  headline: string;
  listing: string;
  businessModel?: string | null;
  products?: string | null;
}): string {
  const listing = opts.listing.trim();
  let h = stripQuarterlyFromHeadline(opts.headline);
  const model = (opts.businessModel || "").trim();
  const productLead = (opts.products || "")
    .split(/[,;|\n]/)
    .map((p) => p.trim())
    .find((p) => p.length >= 12) || "";

  const specific = [model, productLead].find((s) => {
    if (s.length < 12) return false;
    return listing.length < 40 || phraseGroundedInListing(listing, s);
  });

  if (!h && specific) return specific.slice(0, 120);
  if (!specific || listing.length < 40) return h.slice(0, 120);

  const hTok = contentTokens(h);
  const listingTok = contentTokens(listing);
  const specTok = contentTokens(specific);
  const extra = [...specTok].filter(
    (t) => listingTok.has(t) && !hTok.has(t) && !COARSE_HEADLINE_WORDS.has(t),
  );
  const coarse =
    hTok.size > 0 && [...hTok].every((t) => COARSE_HEADLINE_WORDS.has(t) || STOP.has(t));
  if ((coarse || hTok.size <= 3) && extra.length >= 1) {
    return specific.slice(0, 120);
  }
  return h.slice(0, 120);
}
