/**
 * Tracked investors — primary purpose of SME universe scraping.
 */
export type TrackedInvestor = {
  id: string;
  label: string;
  short: string;
  /** Highlight as primary watch target in UI. */
  primary: boolean;
  patterns: RegExp[];
  note?: string;
};

export const TRACKED_INVESTORS: TrackedInvestor[] = [
  {
    id: "trilithon",
    label: "Trilithon",
    short: "Trilithon",
    primary: true,
    patterns: [
      /trilithon/i,
      /trilithon asset management/i,
      /trilithon hidden gems/i,
      /hidden gems scheme/i,
    ],
    note: "Hidden Gems AIF · NSE name: Trilithon Asset Management-Trilithon Hidden Gems Scheme",
  },
  {
    id: "devabhaktuni",
    label: "Manohar Devabhaktuni",
    short: "M. Devabhaktuni",
    primary: true,
    patterns: [
      /manohar devabhaktuni/i,
      /devabhaktuni/i,
      /m\.?\s*devabhaktuni/i,
    ],
    note: "Disclosed HNI · check shareholding + SAST (may not appear in bulk deals)",
  },
  {
    id: "whiteoak",
    label: "WhiteOak",
    short: "WhiteOak",
    primary: false,
    patterns: [/whiteoak/i, /white oak/i],
  },
  {
    id: "kacholia",
    label: "Ashish Kacholia",
    short: "Kacholia",
    primary: false,
    patterns: [/ashish kacholia/i, /kacholia/i],
  },
  {
    id: "kedia",
    label: "Vijay Kedia",
    short: "Kedia",
    primary: false,
    patterns: [/vijay kedia/i],
  },
  {
    id: "aif",
    label: "AIF / Cat III",
    short: "AIF",
    primary: false,
    patterns: [/\baif\b/i, /alternative investment/i, /category iii/i],
  },
  {
    id: "pms",
    label: "PMS",
    short: "PMS",
    primary: false,
    patterns: [/\bpms\b/i, /portfolio manag/i],
  },
];

export function matchInvestors(clientName: string): string[] {
  const name = clientName.trim();
  if (!name) return [];
  const ids: string[] = [];
  for (const inv of TRACKED_INVESTORS) {
    if (inv.patterns.some((re) => re.test(name))) ids.push(inv.id);
  }
  return ids;
}

export function primaryInvestorIds(): string[] {
  return TRACKED_INVESTORS.filter((i) => i.primary).map((i) => i.id);
}

export function investorById(id: string): TrackedInvestor | undefined {
  return TRACKED_INVESTORS.find((i) => i.id === id);
}

/** All patterns for bulk-deals retag (includes secondary investors). */
export function allSmartMoneyPatterns(): RegExp[] {
  const seen = new Set<string>();
  const out: RegExp[] = [];
  for (const inv of TRACKED_INVESTORS) {
    for (const p of inv.patterns) {
      const k = p.source;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}
