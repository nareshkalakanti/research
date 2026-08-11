export {
  DISTRESS_SEED_TICKERS,
  DISTRESS_FLAG_LABELS,
  DISTRESS_DRAWDOWN_MIN_PCT,
  DISTRESS_MCAP_SWEET_MAX_CR,
} from "./config";
export {
  fetchDistressMetrics,
  fetchDistressMetricsBatch,
} from "./metrics";
export {
  scoreDistressTurnaround,
  type DistressMetrics,
  type DistressScoreResult,
} from "./score";
export {
  distressSeedSet,
  distressHoldingsSet,
  isDistressTicker,
  DISTRESS_LISTS,
  tickersForDistressList,
  companiesForDistressList,
  distressMarketForList,
  type DistressMarket,
} from "./tickers";
export { isDistressScanList, type DistressListId } from "./types";
export {
  upsertDistressScores,
  getCachedDistress,
  listCachedDistress,
  tickersNeedingDistressScan,
  countFreshDistressCache,
} from "./cache";

/** Seven gates to discover new distress candidates (beyond seeds). */
export const DISTRESS_DISCOVERY_GATES = [
  {
    id: "universe",
    title: "1. Surveillance universe",
    detail:
      "Start from NSE ASM/GSM CSV lists (+ Pocketful mirror). Exchange-flagged vulnerable names.",
  },
  {
    id: "earnings_stress",
    title: "2. Earnings stress",
    detail: "EPS YoY < 0 or trailing P/E ≥ 80 (depressed earnings).",
  },
  {
    id: "sales_pressure",
    title: "3. Sales pressure",
    detail: "Sales YoY < −15% flags revenue collapse.",
  },
  {
    id: "drawdown",
    title: "4. Price drawdown",
    detail: "Price −20% to −70% from 52-week high.",
  },
  {
    id: "turn_tell",
    title: "5. Turnaround tell",
    detail: "Sales YoY beats EPS YoY by 10+ pts — ops holding while profits broke.",
  },
  {
    id: "bounce",
    title: "6. Bounce off lows",
    detail: "Price +15% to +80% from 52-week low — tape turning.",
  },
  {
    id: "size_value",
    title: "7. Size + value",
    detail: "Mcap ≤ ₹500 Cr; cheap P/E (≤18) or P/B ≤ 3.5.",
  },
] as const;
