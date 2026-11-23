/** Client-safe types for Napkin fundamentals extras (no Node imports). */

export type NapkinCorpAction = {
  /** Dividend | Bonus | Split | Rights | … */
  name: string;
  expiry_date: string | null;
  amount: number | null;
  /** Bonus/split ratio when present (e.g. 1:1). */
  ratio: string | null;
  detail: string | null;
  source: "upstox" | "indianapi";
};

export type NapkinPromoterPoint = { period: string; pct: number };

export type NapkinExtras = {
  ticker: string;
  isin: string | null;
  source: string;
  other_income_pct: number | null;
  other_income_period: string | null;
  promoter: NapkinPromoterPoint[];
  promoter_delta_pp: number | null;
  ocf: Array<{ period: string; value: number }>;
  ocf_trend: "rising" | "falling" | "flat" | null;
  corp_actions: NapkinCorpAction[];
  analyst: {
    consensus: string;
    buy: number;
    hold: number;
    sell: number;
    total: number;
    source: string;
  } | null;
};
