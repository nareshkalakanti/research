/** Multi-agent stock analysis — shared types (spec-aligned evidence bundle). */

export type AgentId =
  | "scout"
  | "technician"
  | "fundamentalist"
  | "newsdesk"
  | "bull"
  | "bear"
  | "judge"
  | "messenger";

export type AgentStatus = "offline" | "working" | "done";

export type RunMode = "demo" | "live";

/** NSE / SME boards, full union, or personal watchlists (Hold / Edge). */
export type ListMarket = "NSE" | "NSE SME" | "All" | "Hold" | "Edge";

export type VerdictLabel = "BUY" | "WATCH" | "AVOID";

export type EvidenceBundle = {
  symbol: string;
  name: string;
  cap_segment: string;
  sector: string | null;
  market: string;
  price: {
    live: number | null;
    day_open: number | null;
    day_high: number | null;
    day_low: number | null;
    prev_close: number | null;
    day_change_pct: number | null;
    volume: number | null;
  };
  range_52w: {
    high: number | null;
    low: number | null;
    pct_from_high: number | null;
    position_pct: number | null;
  };
  technicals: {
    rvol: number | null;
    price_vs_sma_pct: number | null;
    window_return_pct: number | null;
    swing_high: number | null;
    swing_low: number | null;
    day_range_position_pct: number | null;
    trend: "up" | "down" | "sideways" | null;
  };
  analyst: {
    consensus: string | null;
    num_analysts: number | null;
    buy_pct: number | null;
    hold_pct: number | null;
    sell_pct: number | null;
    target_mean: number | null;
    target_low: number | null;
    target_high: number | null;
    upside_pct: number | null;
  };
  news: {
    total: number;
    positive: number;
    negative: number;
    neutral: number;
    recent: Array<{ title: string; link: string; published: string | null }>;
  };
  data_gaps: string[];
  /** Weekly BB/TQ stamps from local scan. */
  weekly?: {
    has_bb: boolean;
    has_tq: boolean;
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
  };
};

export type AgentScore = {
  score: number;
  reasons: string[];
};

export type EvaluationResult = {
  scores: {
    technician: AgentScore;
    fundamentalist: AgentScore;
    newsdesk: AgentScore;
    bull: AgentScore;
    bear: AgentScore;
  };
  verdict: {
    winner: "Bull" | "Bear";
    verdict: VerdictLabel;
    confidence: number;
    rationale: string;
    key_catalyst: string;
    bull_score: number;
    bear_score: number;
    net: number;
  };
  engine: "deterministic" | "llm";
  verification_warnings?: string[];
};

export type AgentCardState = {
  id: AgentId;
  name: string;
  role: string;
  stat1Label: string;
  stat2Label: string;
  stat1: string | number;
  stat2: string | number;
  status: AgentStatus;
};

export type VerdictRow = {
  symbol: string;
  name: string;
  cap_segment: string;
  market: string;
  verdict: VerdictLabel;
  confidence: number;
  why: string;
  key_catalyst: string;
  winner: string;
  price: number | null;
  day_change_pct: number | null;
  rvol: number | null;
  trend: "up" | "down" | "sideways" | null;
  fired: boolean;
  engine: string;
  web: string | null;
  sc: string;
  tv: string;
  about: string | null;
  headquarters: string | null;
  has_hold?: boolean;
  has_edge?: boolean;
  has_niveshaay?: boolean;
  has_negen?: boolean;
  has_tq?: boolean;
  has_bb?: boolean;
};

export type AgentRunProgress = {
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
};

export type AgentRunState = {
  running: boolean;
  mode: RunMode | null;
  list: ListMarket | null;
  started_at: string | null;
  finished_at: string | null;
  engine: "deterministic" | "llm" | null;
  error: string | null;
  progress: AgentRunProgress | null;
  kpis: {
    universe: number;
    in_debate: number;
    buy_signals: number;
    top_pick: { symbol: string; confidence: number } | null;
  };
  agents: AgentCardState[];
  verdicts: VerdictRow[];
  run_id: number | null;
};

export const AGENT_DEFS: Array<{
  id: AgentId;
  name: string;
  role: string;
  stat1Label: string;
  stat2Label: string;
}> = [
  {
    id: "scout",
    name: "Scout",
    role: "screens the stock universe for movers",
    stat1Label: "Scanned",
    stat2Label: "Shortlisted",
  },
  {
    id: "technician",
    name: "Technician",
    role: "reads price action, RVOL & trend",
    stat1Label: "Analyzed",
    stat2Label: "Avg RVOL",
  },
  {
    id: "fundamentalist",
    name: "Fundamentalist",
    role: "weighs valuation & analyst targets",
    stat1Label: "Covered",
    stat2Label: "Avg upside",
  },
  {
    id: "newsdesk",
    name: "Newsdesk",
    role: "pulls live news & scores sentiment",
    stat1Label: "Headlines",
    stat2Label: "Net tone",
  },
  {
    id: "bull",
    name: "Bull",
    role: "argues the case to buy",
    stat1Label: "Cases",
    stat2Label: "Avg score",
  },
  {
    id: "bear",
    name: "Bear",
    role: "argues the case against",
    stat1Label: "Cases",
    stat2Label: "Avg score",
  },
  {
    id: "judge",
    name: "Judge",
    role: "weighs the debate, issues verdict + confidence",
    stat1Label: "Verdicts",
    stat2Label: "Buy",
  },
  {
    id: "messenger",
    name: "Signals",
    role: "records BUY signals (analysis only — no trades sent)",
    stat1Label: "Logged",
    stat2Label: "Engine",
  },
];
