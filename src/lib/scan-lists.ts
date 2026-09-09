/** Scan tab list selector — exchange universes + personal watchlists. */
import {
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  fundKeyFromScanList,
  type FundWatchlistKey,
} from "./fund-watchlist-meta";

export type ScanList =
  | "All"
  | "NSE"
  | "NSE SME"
  | "BSE SME"
  | "Hold"
  | "Edge"
  | (typeof FUND_WATCHLIST_LABELS)[FundWatchlistKey];

export const SCAN_LISTS: ScanList[] = [
  "All",
  "NSE",
  "NSE SME",
  "BSE SME",
  "Hold",
  "Edge",
  ...FUND_WATCHLIST_KEYS.map((k) => FUND_WATCHLIST_LABELS[k]),
];

export function isScanWatchlist(list: string): boolean {
  return (
    list === "Hold" ||
    list === "Edge" ||
    fundKeyFromScanList(list) != null
  );
}

export function scanListLabel(list: ScanList): string {
  if (list === "Hold") return "Holdings";
  return list;
}

export { fundKeyFromScanList };
