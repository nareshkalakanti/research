import { edgeTickerSet } from "../edge";
import {
  FUND_WATCHLIST_KEYS,
  type FundWatchlistKey,
} from "../fund-watchlist-meta";
import { fundWatchlistSets } from "../fund-watchlists";
import { holdingsTickerSet } from "../holdings";

export type StrategyTagFilters = {
  hold?: boolean;
  edge?: boolean;
  sme?: boolean;
  funds?: Partial<Record<FundWatchlistKey, boolean>>;
};

export type StrategyTagCounts = {
  hold: number;
  edge: number;
  sme: number;
} & Partial<Record<FundWatchlistKey, number>>;

export function passesStrategyTags(
  ticker: string,
  market: string,
  tags?: StrategyTagFilters,
): boolean {
  if (!tags) return true;
  const t = ticker.toUpperCase();
  if (tags.hold && !holdingsTickerSet().has(t)) return false;
  if (tags.edge && !edgeTickerSet().has(t)) return false;
  if (tags.sme && market !== "NSE SME" && market !== "BSE SME") return false;

  const activeFunds = FUND_WATCHLIST_KEYS.filter((k) => tags.funds?.[k]);
  if (activeFunds.length) {
    const sets = fundWatchlistSets();
    if (!activeFunds.some((k) => sets[k]?.has(t))) return false;
  }
  return true;
}

export function strategyTagCounts(
  rows: Array<{ ticker: string; market: string }>,
): StrategyTagCounts {
  const holdings = holdingsTickerSet();
  const edge = edgeTickerSet();
  const fundSets = fundWatchlistSets();
  const counts: StrategyTagCounts = {
    hold: 0,
    edge: 0,
    sme: 0,
    niveshaay: 0,
    negen: 0,
    kacholia: 0,
    mukul: 0,
    kedia: 0,
    singhania: 0,
    kela: 0,
  };

  for (const row of rows) {
    const t = row.ticker.toUpperCase();
    if (holdings.has(t)) counts.hold += 1;
    if (edge.has(t)) counts.edge += 1;
    if (row.market === "NSE SME" || row.market === "BSE SME") counts.sme += 1;
    for (const key of FUND_WATCHLIST_KEYS) {
      if (fundSets[key]?.has(t)) counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

export function parseStrategyTagFilters(sp: URLSearchParams): StrategyTagFilters {
  const funds = Object.fromEntries(
    FUND_WATCHLIST_KEYS.map((k) => [k, sp.get(k) === "1"]),
  ) as Partial<Record<FundWatchlistKey, boolean>>;

  return {
    hold: sp.get("hold") === "1",
    edge: sp.get("edge") === "1",
    sme: sp.get("sme") === "1",
    funds,
  };
}

export function appendStrategyTagParams(
  params: URLSearchParams,
  tags: StrategyTagFilters,
): void {
  if (tags.hold) params.set("hold", "1");
  if (tags.edge) params.set("edge", "1");
  if (tags.sme) params.set("sme", "1");
  if (tags.funds) {
    for (const key of FUND_WATCHLIST_KEYS) {
      if (tags.funds[key]) params.set(key, "1");
    }
  }
}
