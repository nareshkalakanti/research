/** Scan tab list selector — exchange universes + personal watchlists. */
export type ScanList =
  | "All"
  | "NSE"
  | "NSE SME"
  | "BSE SME"
  | "Hold"
  | "Edge"
  | "Niveshaay"
  | "Negen";

export const SCAN_LISTS: ScanList[] = [
  "All",
  "NSE",
  "NSE SME",
  "BSE SME",
  "Hold",
  "Edge",
  "Niveshaay",
  "Negen",
];

export function isScanWatchlist(list: string): boolean {
  return (
    list === "Hold" ||
    list === "Edge" ||
    list === "Niveshaay" ||
    list === "Negen"
  );
}

export function scanListLabel(list: ScanList): string {
  if (list === "Hold") return "Holdings";
  return list;
}
