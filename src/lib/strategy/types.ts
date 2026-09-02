export type BuybackStatus =
  | "announced"
  | "open"
  | "closed"
  | "cancelled"
  | "noise";

export type BuybackMethod = "tender" | "open_market" | "unknown";

export type BuybackEvent = {
  id: string;
  ticker: string;
  announced_at: string | null;
  ex_date: string | null;
  max_price: number | null;
  pct_equity: number | null;
  size_shares: number | null;
  status: BuybackStatus;
  subject: string | null;
  description: string | null;
  source: "nse_action" | "nse_announcement" | "screener_announcement";
  seq_id: string | null;
};

export type BuybackSummary = {
  ticker: string;
  name: string;
  market: string;
  market_cap_cr: number | null;
  price: number | null;
  event_count: number;
  latest_date: string | null;
  latest_status: BuybackStatus | null;
  buyback_method: BuybackMethod;
  max_price: number | null;
  pct_equity: number | null;
  spread_pct: number | null;
  buyback_score: number;
  flags: string[];
  reason: string;
  has_history: boolean;
  events: BuybackEvent[];
  sc: string;
  tv: string;
  web: string | null;
};

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
  | "buyback"
  | "liquidity"
  | "concall_drift"
  | "market_turnover";
