export type ConcallDriftEvent = {
  id: string;
  ticker: string;
  earn_at: string;
  concall_at: string | null;
  quarter_fy: string | null;
  earn_subject: string | null;
  concall_subject: string | null;
  baseline_close: number | null;
  drift_pct: number | null;
  has_baseline: boolean;
  source: "nse_announcements";
};

export type ConcallDocLinks = {
  summary: string | null;
  transcript: string | null;
  ppt: string | null;
};

export type ConcallResultQuality = "excellent" | "strong" | "mixed" | "weak";
export type ConcallSentiment = "bullish" | "optimistic" | "neutral" | "bearish";

export type ConcallDriftRow = {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  market_cap_cr: number | null;
  price: number | null;
  earn_at: string;
  concall_at: string | null;
  quarter_fy: string | null;
  baseline_close: number | null;
  drift_pct: number | null;
  has_baseline: boolean;
  earn_subject: string | null;
  has_bb: boolean;
  has_bb_w: boolean;
  has_bb_m: boolean;
  has_tq: boolean;
  has_edge: boolean;
  has_hold: boolean;
  fund_tags: import("../fund-watchlist-meta").FundWatchlistKey[];
  docs: ConcallDocLinks;
  highlights: string[];
  result_quality: ConcallResultQuality | null;
  mgmt_sentiment: ConcallSentiment | null;
  sc: string;
  tv: string;
  web: string | null;
};
