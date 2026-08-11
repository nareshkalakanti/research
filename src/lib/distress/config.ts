/** Distress / turnaround scoring — ported from stocks-ai distress strategy. */

export const DISTRESS_SEED_TICKERS = [
  "GPTINFRA",
  "HMT",
  "LOKESHMACH",
  "ATAM",
  "MIRCELECTR",
  "TEAMGTY",
  "DGCONTENT",
  "BPL",
] as const;

export const DISTRESS_DRAWDOWN_MIN_PCT = 20;
export const DISTRESS_MCAP_SWEET_MAX_CR = 500;

/** Human-readable labels for distress_flags. */
export const DISTRESS_FLAG_LABELS: Record<string, string> = {
  seed: "Seed monitor",
  neg_eps_yoy: "EPS ↓ YoY",
  neg_np_yoy: "Profit ↓ YoY",
  stressed_pe: "Stressed P/E",
  drawdown: "52w drawdown",
  sales_pressure: "Sales pressure",
  surveillance: "ASM/GSM",
  sales_gt_eps: "Sales > EPS (turn)",
  bounce: "Off lows",
  cheap_pe: "Cheap P/E",
  small_cap: "≤₹500 Cr",
};
