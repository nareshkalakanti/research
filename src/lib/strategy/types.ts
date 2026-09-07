export type LiquidityScore = {
  ticker: string;
  name: string;
  market: string;
  market_cap_cr: number | null;
  price: number | null;
  avg_value_20d_lakh: number | null;
  avg_value_60d_lakh: number | null;
  avg_value_120d_lakh: number | null;
  ramp_ratio: number | null;
  is_low_liquidity: boolean;
  is_ramping: boolean;
  liquidity_score: number;
  flags: string[];
  reason: string;
  sc: string;
  tv: string;
  web: string | null;
};

export type StrategyKind =
  | "liquidity"
  | "concall_drift"
  | "market_turnover";
