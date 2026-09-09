/** Curated ace-investor list (Trendlyne / SuperStars). */

import investorsJson from "./investors.json";

export type InvestorTagId = "funds" | "legacy" | "query" | "disclosed";

export type SuperstarInvestor = {
  name: string;
  short: string;
  tags: InvestorTagId[];
};

type InvestorJsonEntry = {
  name: string;
  portfolio_id?: string | null;
  funds?: unknown[];
  disclosed_picks?: unknown[];
  tags?: InvestorTagId[];
};

export const INVESTOR_TAG_LABELS: Record<InvestorTagId, string> = {
  funds: "Funds",
  legacy: "Legacy",
  query: "Query",
  disclosed: "Disc",
};

export const INVESTOR_TAG_TITLES: Record<InvestorTagId, string> = {
  funds: "Sub-funds scraped on Trendlyne",
  legacy: "Estate / legacy portfolio",
  query: "Search-only scrape (no Trendlyne portfolio ID)",
  disclosed: "Bulk deals or disclosed picks merged",
};

const SHORT_OVERRIDES: Record<string, string> = {
  "Radhakishan Damani": "R. Damani",
  "Rakesh Jhunjhunwala and Associates": "Jhunjhunwala",
  "Mukul Agrawal": "Mukul Agrawal",
  "Akash Bhanshali": "Bhanshali",
  "Nemish S Shah": "Nemish Shah",
  "Ashish Kacholia": "Kacholia",
  "Sunil Singhania": "Singhania",
  "Madhusudan Kela": "Madhusudan Kela",
  "Anil Kumar Goel and Associates": "Anil Goel",
  "Vijay Kishanlal Kedia": "Kedia",
  "Dolly Khanna": "Dolly Khanna",
  "Ramesh Damani": "Ramesh Damani",
  "Ajay Upadhyaya": "Ajay Upadhyaya",
  "Hitesh Ramji Javeri and Associates": "Hitesh Javeri",
  "Vanaja Sundar Iyer": "Vanaja Iyer",
  "Manohar Devabhaktuni": "Devabhaktuni",
};

function defaultShort(name: string): string {
  if (SHORT_OVERRIDES[name]) return SHORT_OVERRIDES[name];
  const parts = name.split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : name;
}

function deriveTags(entry: InvestorJsonEntry): InvestorTagId[] {
  const tags = new Set<InvestorTagId>(entry.tags ?? []);
  if (entry.funds?.length) tags.add("funds");
  if (!entry.portfolio_id) tags.add("query");
  if (entry.disclosed_picks?.length) tags.add("disclosed");
  return [...tags];
}

export const SUPERSTAR_INVESTORS: SuperstarInvestor[] = (
  investorsJson as InvestorJsonEntry[]
).map((e) => ({
  name: e.name,
  short: defaultShort(e.name),
  tags: deriveTags(e),
}));

export const CURATED_NAMES = new Set(SUPERSTAR_INVESTORS.map((i) => i.name));

const TAGS_BY_NAME = new Map(
  SUPERSTAR_INVESTORS.map((i) => [i.name, i.tags] as const),
);

export function investorTags(name: string): InvestorTagId[] {
  return TAGS_BY_NAME.get(name) ?? [];
}

export function shortName(investor: string): string {
  return SUPERSTAR_INVESTORS.find((i) => i.name === investor)?.short ?? investor;
}

export function initials(name: string): string {
  const short = shortName(name);
  const parts = short.replace(/[^a-zA-Z\s.]/g, " ").trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return short.slice(0, 2).toUpperCase();
}
