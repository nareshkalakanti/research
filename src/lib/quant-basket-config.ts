/** Thresholds for Scan · Basket (small-cap screen). Tune here, not in factor math. */
export const QUANT_BASKET_CONFIG = {
  universe: {
    mcap_min_cr: 500,
    mcap_max_cr: 5000,
    min_listing_years: 3,
  },
  earnings_quality: {
    lookback_quarters: 8,
    min_quarters: 4,
    weights: { opm_std: -1, pat_cv: -1 },
  },
  score_weights: { gov: 0.3, eq: 0.4, val: 0.3 },
  portfolio: {
    n_stocks: 25,
    max_sector_weight: 0.2,
  },
} as const;
