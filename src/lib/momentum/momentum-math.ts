import type { Bar } from "../indicators";

/** ~126 trading sessions ≈ 6 months */
export const LOOKBACK_6M = 126;
/** ~252 trading sessions ≈ 12 months */
export const LOOKBACK_12M = 252;
export const VOL_WINDOW = 252;
const MIN_STD_PCT = 0.5;

export type MomentumMetrics = {
  return_6m: number | null;
  return_12m: number | null;
  std_dev_1y: number | null;
  momentum_score: number | null;
  price: number | null;
};

function priceReturnPct(closes: number[], lookback: number): number | null {
  if (closes.length < lookback + 1) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - lookback]!;
  if (!(then > 0) || !(now > 0)) return null;
  return Math.round((now / then - 1) * 1000) / 10;
}

/** Annualized daily log-return volatility (%). */
function annualizedStdDevPct(closes: number[], window = VOL_WINDOW): number | null {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(-window - 1);
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1]!;
    const cur = slice[i]!;
    if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
  }
  if (rets.length < window - 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const dailyStd = Math.sqrt(variance);
  return Math.round(dailyStd * Math.sqrt(252) * 1000) / 10;
}

/**
 * Groww-style momentum score:
 * [(6m return / 1yr σ) + (12m return / 1yr σ)] / 2
 * Returns and σ are in percentage points.
 */
export function computeMomentumMetrics(bars: Bar[]): MomentumMetrics {
  const closes = bars.map((b) => b.close).filter((c) => c > 0);
  const price = closes.length ? closes[closes.length - 1]! : null;

  if (closes.length < LOOKBACK_12M + 1) {
    return {
      return_6m: null,
      return_12m: null,
      std_dev_1y: null,
      momentum_score: null,
      price,
    };
  }

  const return_6m = priceReturnPct(closes, LOOKBACK_6M);
  const return_12m = priceReturnPct(closes, LOOKBACK_12M);
  const std_dev_1y = annualizedStdDevPct(closes);

  let momentum_score: number | null = null;
  if (return_6m != null && return_12m != null && std_dev_1y != null) {
    const std = Math.max(std_dev_1y, MIN_STD_PCT);
    momentum_score =
      Math.round(((return_6m / std + return_12m / std) / 2) * 100) / 100;
  }

  return { return_6m, return_12m, std_dev_1y, momentum_score, price };
}

export function momentumFormulaText(): string {
  return "[(6m return ÷ 1yr σ) + (12m return ÷ 1yr σ)] ÷ 2";
}
