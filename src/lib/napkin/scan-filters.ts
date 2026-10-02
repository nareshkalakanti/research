/**
 * Scanner row shape and filters. No database, filesystem, or CAGR imports.
 * Safe for client components.
 */

export type EpsHistoryLabel = "5Y" | "3Y" | "1Y" | "Insufficient";

export type MinEpsHistory = "any" | "1Y" | "3Y" | "5Y";

const HISTORY_RANK: Record<EpsHistoryLabel, number> = {
  Insufficient: 0,
  "1Y": 1,
  "3Y": 2,
  "5Y": 3,
};

export function passesMinEpsHistory(
  history: EpsHistoryLabel,
  min: MinEpsHistory,
): boolean {
  if (min === "any") return true;
  return HISTORY_RANK[history] >= HISTORY_RANK[min];
}

export function parseMinEpsHistory(raw: string | null | undefined): MinEpsHistory {
  const s = (raw || "").trim();
  if (s === "any" || s === "1Y" || s === "3Y" || s === "5Y") return s;
  return "5Y";
}

export function epsHistoryWarning(history: EpsHistoryLabel): string | null {
  if (history === "3Y") return "Less than 5 years of EPS history";
  if (history === "1Y" || history === "Insufficient") {
    return "Limited financial history";
  }
  return null;
}

export type NapkinStockScanRow = {
  ticker: string;
  name: string;
  market_cap_cr: number | null;
  pe: number | null;
  history: EpsHistoryLabel;
  eps_1y: number | null;
  eps_3y: number | null;
  eps_5y: number | null;
  revenue_cagr_3y: number | null;
  revenue_cagr_5y: number | null;
  /** Latest annual ROCE in percent points, as stored on the Screener series. */
  roce: number | null;
  required_cagr: number | null;
  growth_gap: number | null;
  /** Latest stored price. Null when no live quote is cached. */
  price: number | null;
  /** Stored current EPS. Null when it was not loaded. Not derived from price ÷ P/E. */
  eps: number | null;
  /** Default 15% / current P/E / 15% / 5-year maximum buy price. */
  buy_price: number | null;
  /** Listing market for the TradingView symbol, when known. */
  market: string | null;
  warning: string | null;
};

export type NapkinScanStatus = "Research" | "Watch" | "N/A";

export type NapkinScanFilter = {
  history: MinEpsHistory;
  mcapMin: number | null;
  mcapMax: number | null;
  peMax: number | null;
  /** Minimum 5Y EPS CAGR as a ratio (0.1 = 10%). */
  eps5Min: number | null;
  /** Minimum 3Y EPS CAGR as a ratio. */
  eps3Min: number | null;
  /** Minimum 5Y revenue CAGR as a ratio. */
  rev5Min: number | null;
  /** Minimum ROCE in percent points. */
  roceMin: number | null;
  /** Minimum growth gap as a ratio. */
  gapMin: number | null;
};

/** Initial scanner screen. Ratios are 0.15 = 15%. ROCE is percent points. */
export const DEFAULT_NAPKIN_SCAN_FILTER: NapkinScanFilter = {
  history: "5Y",
  mcapMin: null,
  mcapMax: null,
  peMax: 40,
  eps5Min: 0.15,
  eps3Min: 0.1,
  rev5Min: 0.1,
  roceMin: 15,
  gapMin: -0.1,
};

function meetsMin(value: number | null, min: number | null): boolean {
  if (min == null) return true;
  return value != null && value >= min;
}

/**
 * Names still missing a scanned P/E. In-band market caps go first so the
 * default screen fills before the rest of the annual cache.
 */
export function orderTickersForPeScan(
  tickers: readonly string[],
  seen: ReadonlySet<string>,
  marketCapCr: ReadonlyMap<string, number>,
  band: { min: number; max: number },
): string[] {
  const inBand: string[] = [];
  const rest: string[] = [];
  for (const raw of tickers) {
    const ticker = raw.trim().toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    const mcap = marketCapCr.get(ticker);
    if (mcap != null && mcap >= band.min && mcap <= band.max) inBand.push(ticker);
    else rest.push(ticker);
  }
  inBand.sort((a, b) => a.localeCompare(b));
  rest.sort((a, b) => a.localeCompare(b));
  return [...inBand, ...rest];
}

/** A set filter drops rows that lack that metric. An unset filter does not. */
export function passesNapkinScanFilters(
  row: NapkinStockScanRow,
  filter: NapkinScanFilter,
): boolean {
  if (!passesMinEpsHistory(row.history, filter.history)) return false;
  if (!meetsMin(row.market_cap_cr, filter.mcapMin)) return false;
  if (filter.mcapMax != null && (row.market_cap_cr == null || row.market_cap_cr > filter.mcapMax)) {
    return false;
  }
  if (filter.peMax != null && (row.pe == null || row.pe > filter.peMax)) return false;
  if (!meetsMin(row.eps_5y, filter.eps5Min)) return false;
  if (!meetsMin(row.eps_3y, filter.eps3Min)) return false;
  if (!meetsMin(row.revenue_cagr_5y, filter.rev5Min)) return false;
  if (!meetsMin(row.roce, filter.roceMin)) return false;
  if (!meetsMin(row.growth_gap, filter.gapMin)) return false;
  return true;
}

function passesCoreScanFilters(
  row: NapkinStockScanRow,
  filter: NapkinScanFilter,
): boolean {
  return passesNapkinScanFilters(row, { ...filter, gapMin: null });
}

/**
 * Screening label only. Research requires every active filter and a
 * non-negative growth gap. Watch is the same core screen with a gap
 * from -10% up to, but not including, zero.
 */
export function napkinScanStatus(
  row: NapkinStockScanRow,
  filter: NapkinScanFilter,
): NapkinScanStatus {
  if (!passesCoreScanFilters(row, filter) || row.growth_gap == null) return "N/A";
  if (row.growth_gap >= 0 && passesNapkinScanFilters(row, filter)) return "Research";
  if (row.growth_gap >= -0.1 && row.growth_gap < 0) return "Watch";
  return "N/A";
}

export function napkinScanQuoteNote(missing: number, total: number): string | null {
  if (total <= 0) return null;
  if (missing <= 0) return "Financial data loaded · Live quotes available";
  if (missing >= total) return "Financial data loaded · Live quotes unavailable";
  return `Partial data · ${missing} stocks could not be refreshed`;
}
