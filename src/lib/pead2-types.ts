export type Pead2Row = {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  /** Display mcap: live price × shares when possible. */
  mcap_cr: number | null;
  /** Cached metrics mcap (for stale badge vs live). */
  mcap_stored_cr: number | null;
  /** Shares implied from metrics mcap÷price (for live mcap = price × shares). */
  shares: number | null;
  /** ISO time of metrics quote used for mcap/price. */
  metrics_as_of: string | null;
  price: number | null;
  cap_code: string | null;
  web: string | null;
  sc: string;
  tv: string;
  pead_score: number | null;
  result_date: string | null;
  pe_ratio: number | null;
  forward_pe: number | null;
  returns_pct: number | null;
  daily_ret_pct: number | null;
  sales_yoy: number | null;
  sales_qoq: number | null;
  np_yoy: number | null;
  np_qoq: number | null;
  ebidt_yoy: number | null;
  ebidt_qoq: number | null;
  cf_profit: number | null;
  has_tq: boolean;
  has_bb: boolean;
};
