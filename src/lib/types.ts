import type { FundWatchlistKey } from "@/lib/fund-watchlist-meta";

export type Company = {
  ticker: string;
  name: string;
  market: string;
  website: string | null;
  about: string | null;
  headquarters: string | null;
  ceo?: string | null;
  managing_director?: string | null;
  founded_year?: string | null;
  scraped_about?: string | null;
  scrape_source_url?: string | null;
  /** Theme/custom keywords that hit inside scraped website text. */
  scrape_highlights?: string[];
  sector: string | null;
  sub_sector: string | null;
  price: number | null;
  mcap_cr: number | null;
  web: string | null;
  sc: string;
  tv: string;
  matched?: string[];
  /** Themes this company matches (short tags for chips). */
  matched_themes?: MatchedThemeTag[];
  /** Keyword phrases to highlight inside About text. */
  highlights?: string[];
  /** BB NEW weekly breakout. */
  has_bb?: boolean;
  /** BB NEW weekly (BB W). */
  has_bb_w?: boolean;
  /** BB NEW monthly (BB M). */
  has_bb_m?: boolean;
  /** TQ weekly signal (local Yahoo scan). */
  has_tq?: boolean;
  /** Daily close above 10/20/50/200 EMA. */
  has_ema?: boolean;
  /** NEW all-time high (daily). */
  has_ath?: boolean;
  /** NEW 52-week high (daily). */
  has_high52?: boolean;
  /** Positive 12−1 price momentum (stocks-ai formula). */
  has_mom?: boolean;
  /** 12−1 momentum % (Price 1M / Price 1Y − 1) × 100. */
  momentum_pct?: number | null;
  /** Cross-sectional rank: 1 = highest momentum in scanned universe. */
  momentum_rank?: number | null;
  /** Saved research note headline tags when present. */
  news?: {
    count: number;
    netTone: number;
    titles?: string[];
  };
  /** In personal holdings (data/holdings.db). */
  has_hold?: boolean;
  /** Fixed distress turnaround seed (8 monitors). */
  has_distress?: boolean;
  /** In Early Edge watchlist (data/edge.db). */
  has_edge?: boolean;
  /** Trendlyne fund watchlist tags (Niveshaay, Negen, Kacholia, …). */
  fund_tags?: FundWatchlistKey[];
  /** QoQ change per fund tag (new / inc / dec from Trendlyne). */
  fund_changes?: Partial<
    Record<FundWatchlistKey, import("@/lib/fund-watchlist-meta").FundChangeInfo>
  >;
  /** Has a saved research note (data/notes.db). */
  has_note?: boolean;
  /** Saved note body when requested / expanded. */
  note?: string | null;
  bb?: {
    timeframe: string;
    signal: string;
    price: number | null;
    upper_band: number | null;
    signal_date: string | null;
  };
  bb_w?: Company["bb"];
  bb_m?: Company["bb"];
  tq?: {
    timeframe: string;
    score: number | null;
    crossover_type: string | null;
    signal_date: string | null;
  };
  ema?: {
    timeframe: string;
    price: number | null;
    ema10: number | null;
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
    signal_date: string | null;
  };
  ath?: {
    timeframe: string;
    price: number | null;
    ath: number | null;
    signal_date: string | null;
  };
  high52?: {
    timeframe: string;
    price: number | null;
    high_52w: number | null;
    signal_date: string | null;
  };
  mom?: {
    timeframe: string;
    price: number | null;
    price_1y: number | null;
    price_1m: number | null;
    momentum_pct: number | null;
    momentum_rank: number | null;
    signal_date: string | null;
  };
  missing?: {
    price: boolean;
    mcap: boolean;
    sector: boolean;
    sub_sector: boolean;
    about: boolean;
    web: boolean;
    scrape: boolean;
    scrape_empty?: boolean;
    scrape_failed?: boolean;
    board?: boolean;
  };
};

export type CapTier = "NC" | "TI" | "MIC" | "SC" | "MC" | "LC";

/**
 * Cap buckets used by Watching / Theme Scanner filters (₹ Cr).
 * NC = missing mcap · TI = &lt; 100 · MIC = 100–500 · SC = 500–5k · MC = 5k–20k · LC ≥ 20k
 */
export function capTier(mcap: number | null | undefined): CapTier {
  if (mcap == null || Number.isNaN(mcap)) return "NC";
  if (mcap < 100) return "TI";
  if (mcap < 500) return "MIC";
  if (mcap < 5000) return "SC";
  if (mcap < 20000) return "MC";
  return "LC";
}

export type Theme = {
  id: string;
  name: string;
  /** Short chip label on company rows. */
  tag?: string;
  /** Optional highlight chip in the theme picker (e.g. "2026"). */
  badge?: string;
  blog_theme: string;
  display_pattern: string;
  keywords: string[];
  keyword_definitions?: Record<string, string>;
};

/** Theme chip shown next to BB / 52W on company rows. */
export type MatchedThemeTag = {
  id: string;
  tag: string;
  name: string;
};

export function formatInr(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `₹${n.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: n < 10 ? 2 : 0,
  })}`;
}

export function formatMcap(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}
