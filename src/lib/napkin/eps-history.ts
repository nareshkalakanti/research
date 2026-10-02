/**
 * Annual EPS history windows. Listing age is not used.
 * A true n-year CAGR needs n+1 annual observations (see annualCagr).
 * Nulls are omitted. They are never stored as 0. A shorter window is never
 * copied into a longer CAGR field.
 */
import { napkinDefaultMaxBuyPrice } from "./buy-price";
import { annualCagr } from "./financials";
import { napkinRequiredEpsCagr } from "./engine";
import {
  epsHistoryWarning as historyWarning,
  type EpsHistoryLabel,
  type NapkinStockScanRow,
} from "./scan-filters";

export {
  epsHistoryWarning,
  parseMinEpsHistory,
  passesMinEpsHistory,
  passesNapkinScanFilters,
} from "./scan-filters";
export type {
  EpsHistoryLabel,
  MinEpsHistory,
  NapkinScanFilter,
  NapkinStockScanRow,
} from "./scan-filters";

export type EpsHistory = {
  history: EpsHistoryLabel;
  /** Finite annual EPS observations, nulls dropped, order kept. */
  observations: number;
  eps_1y: number | null;
  eps_3y: number | null;
  eps_5y: number | null;
};

/** Keep finite annual EPS. Drop null / NaN. Do not replace gaps with 0. */
export function annualEpsObservations(
  values: Array<number | null | undefined>,
): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out.push(v);
  }
  return out;
}

export function epsHistoryFromAnnual(
  values: Array<number | null | undefined>,
): EpsHistory {
  const series = annualEpsObservations(values);
  const y1 = annualCagr(series, 1).value;
  const y3 = annualCagr(series, 3).value;
  const y5 = annualCagr(series, 5).value;
  const history: EpsHistoryLabel =
    y5 != null ? "5Y" : y3 != null ? "3Y" : y1 != null ? "1Y" : "Insufficient";
  return {
    history,
    observations: series.length,
    eps_1y: y1,
    eps_3y: y3,
    eps_5y: y5,
  };
}

/** Growth gap uses 5Y EPS CAGR only. */
export function epsGrowthGap5y(
  eps5: number | null,
  required: number | null,
): number | null {
  if (eps5 == null || required == null) return null;
  if (!Number.isFinite(eps5) || !Number.isFinite(required)) return null;
  return eps5 - required;
}

function finiteOrNull(v: number | null | undefined): number | null {
  if (v == null || typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

/** Last finite annual figure. Nulls are skipped and are not treated as zero. */
export function latestAnnualValue(
  values: Array<number | null | undefined> | null | undefined,
): number | null {
  if (!values) return null;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export function napkinStockScanRow(input: {
  ticker: string;
  name?: string | null;
  eps: Array<number | null | undefined>;
  sales?: Array<number | null | undefined> | null;
  roce?: Array<number | null | undefined> | null;
  market_cap_cr?: number | null;
  pe?: number | null;
  price?: number | null;
  /** Stored current EPS. Do not pass price ÷ P/E. */
  current_eps?: number | null;
  market?: string | null;
}): NapkinStockScanRow {
  const hist = epsHistoryFromAnnual(input.eps);
  const pe = finiteOrNull(input.pe);
  const price = finiteOrNull(input.price);
  const currentEps = finiteOrNull(input.current_eps);
  const required = napkinRequiredEpsCagr(pe);
  return {
    ticker: input.ticker.trim().toUpperCase(),
    name: (input.name || "").trim() || input.ticker.trim().toUpperCase(),
    market_cap_cr: finiteOrNull(input.market_cap_cr),
    pe,
    history: hist.history,
    eps_1y: hist.eps_1y,
    eps_3y: hist.eps_3y,
    eps_5y: hist.eps_5y,
    revenue_cagr_3y: annualCagr(annualEpsObservations(input.sales ?? []), 3).value,
    revenue_cagr_5y: annualCagr(annualEpsObservations(input.sales ?? []), 5).value,
    roce: latestAnnualValue(input.roce),
    required_cagr: required,
    growth_gap: epsGrowthGap5y(hist.eps_5y, required),
    price,
    eps: currentEps,
    buy_price: napkinDefaultMaxBuyPrice({ eps: currentEps, price, pe }),
    market: (input.market || "").trim() || null,
    warning: historyWarning(hist.history),
  };
}
