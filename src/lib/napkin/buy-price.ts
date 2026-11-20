/**
 * Buy-price math for a fixed 5-year horizon.
 * Does not use required EPS CAGR.
 *
 * futureEPS = currentEPS * (1 + expectedCagr)^5
 * futurePrice = futureEPS * exitPe
 * buyPrice = futurePrice / (1 + targetReturn)^5
 * impliedCagr = (futurePrice / currentPrice)^(1/5) - 1
 * upside = futurePrice / currentPrice - 1
 */

export const NAPKIN_BUY_YEARS = 5;
export const NAPKIN_TARGET_RETURN_PRESETS = [0.1, 0.12, 0.15, 0.2];
export const NAPKIN_DEFAULT_TARGET_RETURN = 0.15;
export const NAPKIN_BUY_SENSITIVITY_CAGRS = [0.1, 0.15, 0.2, 0.25, 0.3];
export const NAPKIN_BUY_SENSITIVITY_PES = [20, 25, 30, 35, 40];

/** Fallback scanner assumptions (growth used only when there is no EPS history). */
export const NAPKIN_SCAN_BUY_ASSUMPTIONS = {
  expected_cagr: 0.15,
  target_return: 0.15,
  years: NAPKIN_BUY_YEARS,
} as const;

export const NAPKIN_BUY_SCENARIOS = [
  { name: "Bear", expected_cagr: 0.1, exit_pe: 20 },
  { name: "Base", expected_cagr: 0.15, exit_pe: 25 },
  { name: "Bull", expected_cagr: 0.25, exit_pe: 30 },
] as const;

export type NapkinBuyCase = {
  future_eps: number | null;
  future_price: number | null;
  buy_price: number | null;
  implied_cagr: number | null;
  upside: number | null;
  /** Maximum buy price versus current price. */
  price_gap: number | null;
};

function finite(v: number | null | undefined): number | null {
  if (v == null || typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

export function napkinBuyCase(input: {
  eps: number | null | undefined;
  price: number | null | undefined;
  expected_cagr: number | null | undefined;
  exit_pe: number | null | undefined;
  target_return: number | null | undefined;
  years?: number;
}): NapkinBuyCase {
  const years = input.years && input.years > 0 ? input.years : NAPKIN_BUY_YEARS;
  const eps = finite(input.eps);
  const growth = finite(input.expected_cagr);
  const exitPe = finite(input.exit_pe);
  const target = finite(input.target_return);
  const price = finite(input.price);
  const empty: NapkinBuyCase = {
    future_eps: null,
    future_price: null,
    buy_price: null,
    implied_cagr: null,
    upside: null,
    price_gap: null,
  };
  if (eps == null || growth == null || growth <= -1) return empty;
  const futureEps = eps * Math.pow(1 + growth, years);
  if (!Number.isFinite(futureEps)) return empty;
  if (exitPe == null || exitPe <= 0) {
    return { ...empty, future_eps: futureEps };
  }
  const futurePrice = futureEps * exitPe;
  let buyPrice: number | null = null;
  if (target != null && target > -1 && futurePrice > 0) {
    const discount = Math.pow(1 + target, years);
    if (discount > 0 && Number.isFinite(discount)) buyPrice = futurePrice / discount;
  }
  let implied: number | null = null;
  let upside: number | null = null;
  let gap: number | null = null;
  if (price != null && price > 0 && futurePrice > 0) {
    implied = Math.pow(futurePrice / price, 1 / years) - 1;
    upside = futurePrice / price - 1;
  }
  if (price != null && price > 0 && buyPrice != null) {
    gap = buyPrice / price - 1;
  }
  return {
    future_eps: futureEps,
    future_price: futurePrice,
    buy_price: buyPrice,
    implied_cagr: implied,
    upside,
    price_gap: gap,
  };
}

/** Exit P/E ceiling for the default case: rich multiples are assumed to cool to this. */
export const NAPKIN_EXIT_PE_CAP = 25;
/** Historical EPS CAGR used as the default growth is kept inside this band. */
export const NAPKIN_HIST_GROWTH_MIN = 0;
export const NAPKIN_HIST_GROWTH_MAX = 0.3;

/**
 * Default expected EPS CAGR: the stock's own history (5Y, else 3Y), kept in
 * 0–30%. Falls back to the flat scanner rate when there is no history.
 * A flat 15% with a 15% target and current P/E as exit always returns
 * "max entry = price" — the defaults must come from the stock.
 */
export function napkinDefaultGrowth(historical: number | null | undefined): number {
  const h = finite(historical);
  if (h == null) return NAPKIN_SCAN_BUY_ASSUMPTIONS.expected_cagr;
  return Math.min(NAPKIN_HIST_GROWTH_MAX, Math.max(NAPKIN_HIST_GROWTH_MIN, h));
}

/** Default exit P/E: current P/E, capped at NAPKIN_EXIT_PE_CAP. */
export function napkinDefaultExitPe(pe: number | null | undefined): number | null {
  const p = finite(pe);
  if (p == null || p <= 0) return null;
  return Math.min(p, NAPKIN_EXIT_PE_CAP);
}

/** Default scenario. Missing EPS, price, or P/E stays null. */
export function napkinDefaultMaxBuyPrice(input: {
  eps: number | null | undefined;
  price: number | null | undefined;
  pe: number | null | undefined;
  /** Historical EPS CAGR (5Y, else 3Y) as a ratio. */
  historical_cagr?: number | null;
}): number | null {
  const eps = finite(input.eps);
  const price = finite(input.price);
  const pe = finite(input.pe);
  if (eps == null || price == null || pe == null) return null;
  return napkinBuyCase({
    eps,
    price,
    expected_cagr: napkinDefaultGrowth(input.historical_cagr),
    exit_pe: napkinDefaultExitPe(pe),
    target_return: NAPKIN_SCAN_BUY_ASSUMPTIONS.target_return,
    years: NAPKIN_SCAN_BUY_ASSUMPTIONS.years,
  }).buy_price;
}

export function napkinBuyPricePosition(
  priceGap: number | null | undefined,
): string | null {
  const gap = finite(priceGap);
  if (gap == null) return null;
  if (gap > 1e-9) {
    return "Spot is below your max pay-today — room vs the target return.";
  }
  if (gap < -1e-9) {
    return "Spot is above your max pay-today — you would undershoot the target return if assumptions hold.";
  }
  return "Spot matches your max pay-today under these assumptions.";
}

export function napkinIllustrativeBuyRows(input: {
  eps: number | null | undefined;
  price: number | null | undefined;
  target_return: number | null | undefined;
}): Array<{
  name: string;
  expected_cagr: number;
  exit_pe: number;
  case: NapkinBuyCase;
}> {
  return NAPKIN_BUY_SCENARIOS.map((scenario) => ({
    name: scenario.name,
    expected_cagr: scenario.expected_cagr,
    exit_pe: scenario.exit_pe,
    case: napkinBuyCase({
      eps: input.eps,
      price: input.price,
      expected_cagr: scenario.expected_cagr,
      exit_pe: scenario.exit_pe,
      target_return: input.target_return,
      years: NAPKIN_BUY_YEARS,
    }),
  }));
}
