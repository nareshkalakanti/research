export type Company = {
  ticker: string;
  name: string;
  market: string;
  website: string | null;
  about: string | null;
  headquarters: string | null;
  sector: string | null;
  sub_sector: string | null;
  price: number | null;
  mcap_cr: number | null;
  web: string | null;
  sc: string;
  tv: string;
  matched?: string[];
  /** Keyword phrases to highlight inside About text. */
  highlights?: string[];
  /** BB NEW weekly breakout (local Yahoo scan). */
  has_bb?: boolean;
  /** TQ weekly signal (local Yahoo scan). */
  has_tq?: boolean;
  /** In personal holdings (data/holdings.db). */
  has_hold?: boolean;
  /** Fixed distress turnaround seed (8 monitors). */
  has_distress?: boolean;
  /** In Edge watchlist — Early Edge + Negen + Niveshaay (data/edge.db). */
  has_edge?: boolean;
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
  tq?: {
    timeframe: string;
    score: number | null;
    crossover_type: string | null;
    signal_date: string | null;
  };
  missing?: {
    price: boolean;
    mcap: boolean;
    sector: boolean;
    about: boolean;
    web: boolean;
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
  blog_theme: string;
  display_pattern: string;
  keywords: string[];
};

export type ThemeGroup = {
  blog_theme: string;
  themes: Theme[];
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
