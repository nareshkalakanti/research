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
    .replace(/&amp;/g, " and ")
    .replace(/&/g, " and ")
    .replace(/[\uFF06\uFE60+＋]/g, " and ")
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
  const push = (t: string) => {
    const s = t.trim();
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  push(raw);
  push(key);
  const words = key.split(" ").filter((w) => w.length >= 3);
  if (words.length >= 2) push(words.slice(0, 2).join(" "));
  if (words.length >= 3) push(words.slice(0, 3).join(" "));
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

export function hintListingFitsQuery(
  query: string,
  hintTicker: string,
  hintName: string,
): boolean {
  if (!query.trim() || !hintTicker.trim()) return false;
  return scoreListingName(query, hintTicker, hintName) >= 70;
}

export function compactTicker(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Typed query vs listing ticker/name — includes a short extra suffix on a real ticker. */
export function listingQueryMatches(q: string, ticker: string, name: string): boolean {
  const Q = q.trim().toUpperCase();
  if (!Q) return false;
  const t = ticker.toUpperCase();
  const n = name.toUpperCase();
  if (t === Q || t.startsWith(Q) || t.includes(Q)) return true;
  if (`${t} ${n}`.includes(Q) || n.includes(Q)) return true;
  const cq = compactTicker(Q);
  if (cq.length < 2) return false;
  const ct = compactTicker(t);
  const cn = compactTicker(n);
  if (ct === cq || ct.startsWith(cq) || ct.includes(cq) || cn.includes(cq)) return true;
  if (ct.length >= 3 && cq.startsWith(ct) && cq.length - ct.length <= 2) return true;
  return scoreListingName(q, ticker, name) >= 70;
}

export function rankListingQuery(
  q: string,
  ticker: string,
  name: string,
): number {
  const Q = q.trim().toUpperCase();
  const t = ticker.toUpperCase();
  const n = name.toUpperCase();
  const cq = compactTicker(Q);
  const ct = compactTicker(t);
  if (t === Q || (cq.length >= 2 && ct === cq)) return 0;
  const nameScore = scoreListingName(q, ticker, name);
  if (nameScore >= 96) return 0;
  if (t.startsWith(Q) || (cq.length >= 2 && ct.startsWith(cq))) return 1;
  if (nameScore >= 88) return 1;
  if (ct.length >= 3 && cq.startsWith(ct) && cq.length - ct.length <= 2) return 2;
  if (nameScore >= 80) return 2;
  if (n.startsWith(Q) || nameScore >= 70) return 3;
  if (t.includes(Q) || n.includes(Q)) return 4;
  if (cq.length >= 2 && (ct.includes(cq) || compactTicker(n).includes(cq))) return 5;
  return 9;
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
