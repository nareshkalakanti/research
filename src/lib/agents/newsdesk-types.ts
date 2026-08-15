/** Shared Quant Newsdesk types — safe for client components (no Node/Yahoo imports). */

export const QUANT_NEWS_LIMIT = 30;

export type NewsTone = "pos" | "neg" | "neu";

export type QuantHeadline = {
  title: string;
  link: string;
  published: string | null;
  tone: NewsTone;
};

export type QuantNewsCompanyIn = {
  ticker: string;
  name: string;
  market?: string | null;
  has_tq?: boolean;
  has_bb?: boolean;
};

export type QuantNewsCompany = QuantNewsCompanyIn & {
  ticker: string;
  name: string;
  market: string;
  headlines: QuantHeadline[];
  positive: number;
  negative: number;
  neutral: number;
};

export type QuantNewsdeskResult = {
  companies: QuantNewsCompany[];
  headlines: number;
  netTone: number;
};
