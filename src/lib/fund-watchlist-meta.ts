/** Client-safe fund watchlist ids + labels (no DB). */

export type FundWatchlistKey =
  | "niveshaay"
  | "negen"
  | "kacholia"
  | "mukul"
  | "kedia"
  | "singhania"
  | "kela";

export const FUND_WATCHLIST_KEYS: FundWatchlistKey[] = [
  "niveshaay",
  "negen",
  "kacholia",
  "mukul",
  "kedia",
  "singhania",
  "kela",
];

export const FUND_WATCHLIST_LABELS: Record<FundWatchlistKey, string> = {
  niveshaay: "Niveshaay",
  negen: "Negen",
  kacholia: "Kacholia",
  mukul: "Mukul",
  kedia: "Kedia",
  singhania: "Singhania",
  kela: "Kela",
};

export type FundFilterState = Partial<Record<FundWatchlistKey, boolean>>;

export type FundCountState = Partial<Record<FundWatchlistKey, number>>;

export type FundChangeInfo = {
  change_type: string;
  change_qtr: number | null;
};

const CHANGE_RANK: Record<string, number> = {
  new: 4,
  disclosed: 3,
  increased: 2,
  decreased: 1,
  unchanged: 0,
};

export function isFundChangeVisible(changeType: string | null | undefined): boolean {
  const ct = (changeType ?? "").toLowerCase();
  return ct === "new" || ct === "disclosed" || ct === "increased" || ct === "decreased";
}

export function fundChangeBadge(info: FundChangeInfo | undefined): string | null {
  if (!info || !isFundChangeVisible(info.change_type)) return null;
  const ct = info.change_type.toLowerCase();
  if (ct === "new") return "new";
  if (ct === "disclosed") return "new";
  if (ct === "increased") {
    if (info.change_qtr != null && Number.isFinite(info.change_qtr)) {
      const sign = info.change_qtr >= 0 ? "+" : "";
      return `↑${sign}${info.change_qtr.toFixed(1)}%`;
    }
    return "↑";
  }
  if (ct === "decreased") {
    if (info.change_qtr != null && Number.isFinite(info.change_qtr)) {
      return `↓${info.change_qtr.toFixed(1)}%`;
    }
    return "↓";
  }
  return null;
}

export function fundChangeClass(changeType: string | null | undefined): string {
  const ct = (changeType ?? "").toLowerCase();
  if (ct === "new" || ct === "disclosed") return "fund-chg new";
  if (ct === "increased") return "fund-chg up";
  if (ct === "decreased") return "fund-chg down";
  return "fund-chg flat";
}

export function pickBetterFundChange(
  a: FundChangeInfo | undefined,
  b: FundChangeInfo | undefined,
): FundChangeInfo | undefined {
  if (!a) return b;
  if (!b) return a;
  const ra = CHANGE_RANK[a.change_type.toLowerCase()] ?? 0;
  const rb = CHANGE_RANK[b.change_type.toLowerCase()] ?? 0;
  return rb > ra ? b : a;
}

export function anyFundFilterActive(funds: FundFilterState): boolean {
  return FUND_WATCHLIST_KEYS.some((k) => funds[k]);
}

export function clearFundFilters(): FundFilterState {
  return Object.fromEntries(FUND_WATCHLIST_KEYS.map((k) => [k, false])) as FundFilterState;
}

export function fundKeyFromScanList(list: string): FundWatchlistKey | null {
  for (const key of FUND_WATCHLIST_KEYS) {
    if (FUND_WATCHLIST_LABELS[key] === list) return key;
  }
  return null;
}

export function appendFundParams(
  params: URLSearchParams,
  funds: FundFilterState,
): void {
  for (const key of FUND_WATCHLIST_KEYS) {
    if (funds[key]) params.set(key, "1");
  }
}
