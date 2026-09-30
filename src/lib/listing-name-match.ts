/** Match an extracted issuer label to a listing ticker/name. No issuer lists. */

function collapseSingleLetterRuns(tokens: string[]): string[] {
  const out: string[] = [];
  let run = "";
  for (const t of tokens) {
    if (t.length === 1) {
      run += t;
      continue;
    }
    if (run) {
      out.push(run);
      run = "";
    }
    out.push(t);
  }
  if (run) out.push(run);
  return out;
}

export function companyLabelKey(name: string): string {
  const raw = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(limited|ltd|pvt|private|plc|llc|inc|corp|corporation|company|co)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return collapseSingleLetterRuns(raw.split(" ").filter(Boolean)).join(" ");
}

/** Alternate search strings: dotted initials become a compact token. */
export function listingQueryVariants(query: string): string[] {
  const raw = query.trim();
  if (!raw) return [];
  const key = companyLabelKey(raw);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of [raw, key]) {
    const t = q.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function oneEditApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (Math.min(a.length, b.length) < 5) return false;
  if (a.length === b.length) {
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) diffs += 1;
      if (diffs > 1) return false;
    }
    return diffs === 1;
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
      continue;
    }
    skipped += 1;
    if (skipped > 1) return false;
    j += 1;
  }
  return i === shorter.length;
}

function tokensMatch(a: string, b: string): boolean {
  return a === b || oneEditApart(a, b);
}

export function scoreListingName(
  query: string,
  ticker: string,
  name: string,
): number {
  const q = companyLabelKey(query);
  if (q.length < 4) return 0;
  const t = ticker.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const n = companyLabelKey(name);
  const qCompact = q.replace(/ /g, "");
  if (qCompact.length >= 3 && t === qCompact) return 100;
  if (n === q) return 100;
  const qTokEarly = q.split(" ").filter((w) => w.length > 1);
  const tKey = t.toLowerCase();
  if (
    tKey.length >= 4 &&
    (qTokEarly[0] === tKey || qCompact === tKey || qCompact.startsWith(`${tKey}`))
  ) {
    if (qTokEarly[0] === tKey || qCompact === tKey) return 96;
  }
  if (n && (n.startsWith(q) || q.startsWith(n)) && Math.min(n.length, q.length) >= 8) {
    return 92;
  }
  if (n.includes(q) || (q.includes(n) && n.length >= 8)) {
    const ratio =
      Math.min(n.length, q.length) / Math.max(n.length, q.length || 1);
    return 70 + Math.round(ratio * 22);
  }
  const qTok = q.split(" ").filter((w) => w.length > 1);
  const nTok = n.split(" ").filter((w) => w.length > 1);
  const nSet = new Set(nTok);
  if (qTok.length < 2) return 0;
  const exact = qTok.filter((w) => nSet.has(w)).length;
  if (exact === qTok.length) return 88;
  if (exact / qTok.length >= 0.8) return 75;
  const fuzzy = qTok.filter((w) => nTok.some((x) => tokensMatch(w, x))).length;
  if (fuzzy === qTok.length && qTok[0] && nTok[0] && qTok[0] === nTok[0]) return 82;
  if (fuzzy / qTok.length >= 0.8 && qTok[0] && nTok[0] && qTok[0] === nTok[0]) {
    return 72;
  }
  let prefix = 0;
  while (
    prefix < qTok.length &&
    prefix < nTok.length &&
    tokensMatch(qTok[prefix]!, nTok[prefix]!)
  ) {
    prefix += 1;
  }
  if (prefix >= 2 && qTok.slice(0, prefix).some((w) => w.length >= 5)) {
    return 80;
  }
  return 0;
}

export function pickUniqueListing<T extends { ticker: string; name: string }>(
  query: string,
  rows: T[],
  preferTicker?: string | null,
): T | null {
  const scored = rows
    .map((r) => ({ r, s: scoreListingName(query, r.ticker, r.name) }))
    .filter((x) => x.s >= 70);
  if (!scored.length) return null;
  scored.sort(
    (a, b) => b.s - a.s || a.r.ticker.localeCompare(b.r.ticker),
  );
  const best = scored[0]!;
  const prefer = (preferTicker || "").trim().toUpperCase();
  if (prefer) {
    const p = scored.find((x) => x.r.ticker.toUpperCase() === prefer);
    if (p && p.s >= 70 && p.s + 5 >= best.s) return p.r;
  }
  const second = scored[1];
  if (
    second &&
    second.s >= best.s - 2 &&
    second.r.ticker.toUpperCase() !== best.r.ticker.toUpperCase()
  ) {
    return null;
  }
  return best.r;
}
