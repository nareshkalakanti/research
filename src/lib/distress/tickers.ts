import { loadAllCompanies } from "@/lib/db";
import { DISTRESS_SEED_TICKERS } from "./config";
import type { DistressListId } from "./types";
import { loadTurnaroundHoldings } from "@/lib/turnaround-holdings";

export type { DistressListId } from "./types";
export { isDistressScanList } from "./types";

/** All fixed distress seed tickers (8). */
export function distressSeedSet(): Set<string> {
  return new Set(DISTRESS_SEED_TICKERS.map((t) => t.toUpperCase()));
}

/** Seeds you actually hold (portfolio ∩ seeds). */
export function distressHoldingsSet(): Set<string> {
  return new Set(
    loadTurnaroundHoldings().map((h) => h.ticker.toUpperCase()),
  );
}

export function isDistressTicker(ticker: string): boolean {
  return distressSeedSet().has(ticker.trim().toUpperCase());
}

export type DistressMarket = "NSE" | "NSE SME";

export const DISTRESS_LISTS: Array<{
  id: DistressListId;
  label: string;
  description: string;
  scan?: boolean;
}> = [
  {
    id: "seeds",
    label: "Seed monitors (8)",
    description:
      "Fixed distress turnaround anchors — always scored regardless of portfolio.",
  },
  {
    id: "holdings",
    label: "My distress holdings",
    description: "Seed names you hold in data/holdings.db.",
  },
  {
    id: "nse",
    label: "NSE",
    description:
      "Score NSE main-board names in batches — hit Scan to walk the list.",
    scan: true,
  },
  {
    id: "nse-sme",
    label: "NSE SME",
    description:
      "Score NSE SME names in batches — hit Scan to walk the list.",
    scan: true,
  },
];

export function distressMarketForList(list: DistressListId): DistressMarket | null {
  if (list === "nse") return "NSE";
  if (list === "nse-sme") return "NSE SME";
  return null;
}

export function companiesForDistressList(list: DistressListId) {
  const market = distressMarketForList(list);
  if (market) {
    return loadAllCompanies()
      .filter((c) => c.market === market)
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  }
  const tickers = tickersForDistressList(list);
  const byTicker = new Map(
    loadAllCompanies().map((c) => [c.ticker.toUpperCase(), c]),
  );
  return tickers
    .map((t) => byTicker.get(t))
    .filter((c): c is NonNullable<typeof c> => !!c);
}

export function tickersForDistressList(list: DistressListId): string[] {
  if (list === "holdings") {
    return [...distressHoldingsSet()].sort();
  }
  const market = distressMarketForList(list);
  if (market) {
    return loadAllCompanies()
      .filter((c) => c.market === market)
      .map((c) => c.ticker.toUpperCase())
      .sort();
  }
  return [...distressSeedSet()].sort();
}
