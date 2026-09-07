export type HtStockRow = {
  ticker: string;
  market: string;
  name: string;
  sector: string | null;
  sub_sector: string | null;
  price: number | null;
  market_cap_cr: number | null;
  sales_growth_3y: number;
  roce_3y: number;
  pb: number;
  pe_ratio: number | null;
  growth_rank?: number;
  roce_rank?: number;
  pb_rank?: number;
  total_score?: number;
  rank?: number;
};

export type HtSectorRow = {
  sector: string;
  companies: number;
  score: number;
  indicator: "TAILWIND" | "HEADWIND" | "NEUTRAL";
  median_growth_3y: number | null;
  median_roce_3y: number | null;
  median_pb: number | null;
  avg_total_score: number | null;
};

export type HtCachedRow = {
  ticker: string;
  market: string | null;
  name: string | null;
  price: number | null;
  market_cap_cr: number | null;
  sales_growth_3y: number | null;
  /** 3y net-income CAGR % (earnings). */
  earnings_growth_3y: number | null;
  roce_3y: number | null;
  pb: number | null;
  pe_ratio: number | null;
  fetched_at: string;
  status: "ok" | "empty" | "failed";
  detail: string | null;
};
