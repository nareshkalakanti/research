/**
 * Hidden Portfolio Tracker / SME Alpha Hunter — config.
 * Boutique-fund style catalyst hunt for Indian SME / microcaps.
 */

export const MARKET_CAP_RANGE_INR: [number, number] = [
  200_000_000, // ₹20 Cr
  2_000_000_000, // ₹200 Cr
];

export const MIN_AVG_VOLUME = 1000;
export const NEWS_ITEMS_PER_STOCK = 20;
export const RSS_BASE_URL =
  "https://news.google.com/rss/search?q={query}&hl=en-IN&gl=IN&ceid=IN:en";

export const NEWS_SLEEP_MS = 1200;
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const ALPHA_SCORE_CAP = 200;

export const THEMES_KEYWORDS = {
  moat: [
    "API certification",
    "ISO",
    "CE mark",
    "Defense order",
    "MoU",
    "Patent",
    "Export",
    "Capacity expansion",
    "New plant",
    "Niche",
  ],
  growth: [
    "Order book",
    "Bagged order",
    "Revenue beat",
    "Margin expansion",
    "Turnaround",
    "Capacity utilization",
  ],
  smart_money: [
    "Trilithon",
    "Trilithon Asset Management",
    "Trilithon Partners",
    "Ashish Kacholia",
    "Vijay Kedia",
    "Mukul Agrawal",
    "WhiteOak",
    "Marcellus",
    "Manohar Devabhaktuni",
    "Bulk deal",
    "Block deal",
    "Anchor investor",
    "PMS",
    "AIF",
  ],
} as const;

export type KeywordTheme = keyof typeof THEMES_KEYWORDS;

export type HiddenUniverseRow = {
  symbol: string;
  name: string;
  sector: string;
  market?: string | null;
};

export type HiddenNewsHit = {
  title: string;
  link: string;
  published: string | null;
  matched: string[];
  themes: KeywordTheme[];
};

export type HiddenCandidate = {
  symbol: string;
  name: string;
  sector: string | null;
  market: string | null;
  price: number | null;
  mcap_cr: number | null;
  pe: number | null;
  avg_volume: number | null;
  revenue_growth: number | null;
  profit_margin: number | null;
  alpha_score: number;
  moat_keywords: string[];
  growth_keywords: string[];
  smart_money_flag: boolean;
  smart_money_keywords: string[];
  /** NSE bulk/block deals matched to this symbol (if synced). */
  bulk_deals?: Array<{
    trade_date: string;
    client_name: string;
    side: string;
    quantity: number | null;
    price: number | null;
    deal_type: string;
    smart_money: boolean;
  }>;
  news: HiddenNewsHit[];
  top_headline: string | null;
  top_link: string | null;
  fetched_at: string;
  error?: string;
};
