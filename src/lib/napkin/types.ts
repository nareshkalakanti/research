export type NapkinVerdict = "PASS" | "HOLD" | "FAIL" | "INSUFFICIENT DATA";

export type NapkinMetric = {
  key: string;
  label: string;
  value: string;
};

export type NapkinDocType =
  | "RESULT"
  | "ANNUAL_REPORT"
  | "INVESTOR_PRESENTATION"
  | "CONCALL_TRANSCRIPT"
  | "CORPORATE_ANNOUNCEMENT"
  | "OTHER";

export type NapkinFiling = {
  title: string;
  period: string;
  kind: NapkinDocType;
  source: string;
  url: string;
  picked?: boolean;
};

export type NapkinPdfPage = {
  page_number: number;
  text: string;
};

export type NapkinCagr = {
  revenue_3y: number | null;
  revenue_5y: number | null;
  eps_3y: number | null;
  eps_5y: number | null;
  profit_3y: number | null;
  profit_5y: number | null;
};

export type NapkinDataQuality = {
  annualPeriodsAvailable: number;
  requiredFor3Y: number;
  requiredFor5Y: number;
  threeYearCagrAvailable: boolean;
  fiveYearCagrAvailable: boolean;
  cagr_5y_source: "yahoo" | "screener" | "groww" | null;
  reason: string | null;
  reasons: Record<string, string>;
};

export type NapkinStockJson = {
  ok: boolean;
  error?: string | null;
  error_code?: string | null;
  company_name: string | null;
  ticker: string;
  yf_symbol: string | null;
  sector: string | null;
  fetched_at: string | null;
  price: number | null;
  market_cap: number | null;
  pe: number | null;
  eps: number | null;
  revenue: number | null;
  net_income: number | null;
  ebitda: number | null;
  free_cash_flow: number | null;
  total_debt: number | null;
  cash: number | null;
  shares_outstanding: number | null;
  roe: number | null;
  roce: number | null;
  cagr: NapkinCagr;
  margin: {
    current: number | null;
    "3y": number | null;
    "5y": number | null;
  };
  annuals?: Array<{
    year: string;
    revenue: number | null;
    net_income: number | null;
    eps: number | null;
    ebitda: number | null;
    free_cash_flow: number | null;
  }>;
  data_quality?: NapkinDataQuality;
  warnings?: string[];
};

export type NapkinResearch = {
  ticker: string;
  name: string;
  exchange: string;
  yf_symbol: string | null;
  mock: boolean;
  overview: NapkinMetric[];
  financials: NapkinMetric[];
  napkin: {
    current_pe: string;
    near_term_value: string;
    adjusted_value: string;
    basic_required_cagr: string;
    adjusted_required_cagr: string;
    eps_cagr_3y: string;
    eps_cagr_5y: string;
    growth_gap_3y: string;
    growth_gap_5y: string;
    growth_gap_hist_adjusted_5y: string;
    expected_eps_cagr: string;
    growth_gap_expected_basic: string;
    growth_gap_expected_adjusted: string;
    verdict: NapkinVerdict;
    verdict_note: string;
  };
  filings: NapkinFiling[];
  concall: string[];
  qwen: string[];
  risks: string[];
  data_quality?: NapkinDataQuality;
  data_status?: "complete" | "partial" | "insufficient";
  sources?: string[];
  fetched_at?: string | null;
  sector?: string | null;
  card: {
    headline: string;
    body: string;
  };
};
