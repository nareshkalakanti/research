/** Curated ace-investor list (Trendlyne / SuperStars). */

import investorsJson from "./investors.json";

export type SuperstarInvestor = {
  name: string;
  short: string;
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
  "Ashish Dhawan": "Ashish Dhawan",
  "Porinju V Veliyath": "Porinju",
  "Vijay Kishanlal Kedia": "Kedia",
  "Dolly Khanna": "Dolly Khanna",
  "Ramesh Damani": "Ramesh Damani",
  "Sunil Kumar": "Sunil Kumar",
  "Ajay Upadhyaya": "Ajay Upadhyaya",
  "Hitesh Ramji Javeri and Associates": "Hitesh Javeri",
  "Vanaja Sundar Iyer": "Vanaja Iyer",
  "Sanjay Gupta": "Sanjay Gupta",
  "Nikhil Vora": "Nikhil Vora",
  "Shankar Sharma": "Shankar Sharma",
  "Manohar Devabhaktuni": "Devabhaktuni",
  "Basava Sankara Rao Kolli": "Basava Kolli",
  "Negen Capital / Negen Undiscovered Value Fund": "Negen",
  "Niveshaay": "Niveshaay",
};

function defaultShort(name: string): string {
  if (SHORT_OVERRIDES[name]) return SHORT_OVERRIDES[name];
  const parts = name.split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : name;
}

export const SUPERSTAR_INVESTORS: SuperstarInvestor[] = (
  investorsJson as Array<{ name: string }>
).map((e) => ({
  name: e.name,
  short: defaultShort(e.name),
}));

export const CURATED_NAMES = new Set(SUPERSTAR_INVESTORS.map((i) => i.name));

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
