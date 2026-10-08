/**
 * Composite verdict, entry-price status, MOS, and 1D sensitivity.
 * All path math goes through napkinBuyCase / napkinRequiredEpsCagr.
 */
import {
  napkinBuyCase,
  type NapkinBuyCase,
} from "./buy-price";
import {
  NAPKIN_EXPECTED_CAGR_1D,
  NAPKIN_FACTOR_DEFAULT,
  NAPKIN_FACTOR_PRESETS,
  napkinRequiredEpsCagr,
} from "./engine";

export type NapkinCompositeLabel =
  | "ATTRACTIVE"
  | "REASONABLE"
  | "STRETCHED"
  | "HIGHLY STRETCHED";

export type NapkinEntryStatusLabel =
  | "AT ENTRY PRICE"
  | "WITHIN ENTRY RANGE"
  | "NEAR ENTRY PRICE"
  | "ABOVE ENTRY PRICE";

export type NapkinEntryTone = "good" | "near" | "high";

function finite(v: number | null | undefined): number | null {
  if (v == null || typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

export function napkinMaxPayVsSpot(
  maxPay: number | null | undefined,
  price: number | null | undefined,
): number | null {
  const m = finite(maxPay);
  const p = finite(price);
  if (m == null || p == null || p === 0) return null;
  return m / p - 1;
}

export function napkinEntryPriceStatus(
  price: number | null | undefined,
  maxPay: number | null | undefined,
): { label: NapkinEntryStatusLabel; tone: NapkinEntryTone } | null {
  const p = finite(price);
  const m = finite(maxPay);
  if (p == null || m == null || m <= 0) return null;
  const diffPct = Math.abs(p / m - 1) * 100;
  if (diffPct <= 1) return { label: "AT ENTRY PRICE", tone: "good" };
  if (p < m) return { label: "WITHIN ENTRY RANGE", tone: "good" };
  if (p <= m * 1.1) return { label: "NEAR ENTRY PRICE", tone: "near" };
  return { label: "ABOVE ENTRY PRICE", tone: "high" };
}

export function napkinCompositeVerdict(input: {
  expected_cagr: number | null | undefined;
  required_cagr: number | null | undefined;
  price_cagr: number | null | undefined;
  target_return: number | null | undefined;
  max_pay: number | null | undefined;
  price: number | null | undefined;
}): { label: NapkinCompositeLabel; note: string } | null {
  const expected = finite(input.expected_cagr);
  const required = finite(input.required_cagr);
  const priceCagr = finite(input.price_cagr);
  const target = finite(input.target_return);
  const maxPay = finite(input.max_pay);
  const price = finite(input.price);
  if (
    expected == null ||
    required == null ||
    priceCagr == null ||
    target == null ||
    maxPay == null ||
    price == null ||
    price <= 0
  ) {
    return null;
  }
  const growthGap = expected - required;
  const returnGap = priceCagr - target;

  if (growthGap >= 0 && returnGap >= 0 && maxPay >= price) {
    return {
      label: "ATTRACTIVE",
      note: "Under the selected assumptions, expected growth meets Napkin-required growth, implied price CAGR meets the target return, and Max Entry is at or above spot. This is not an investment recommendation.",
    };
  }
  if (growthGap >= -0.1 || returnGap >= -0.05 || maxPay >= price * 0.9) {
    return {
      label: "REASONABLE",
      note: "The selected assumptions are close to the Napkin path, though one or more of growth, implied return, or Max Entry vs spot do not fully line up. This is not an investment recommendation.",
    };
  }
  if (maxPay < price * 0.75 || (growthGap < -0.2 && returnGap < -0.1)) {
    return {
      label: "HIGHLY STRETCHED",
      note: "Max Entry is well below spot, or both expected growth and implied return sit far below the selected hurdles. This is not an investment recommendation.",
    };
  }
  return {
    label: "STRETCHED",
    note: "Expected growth is below the Napkin-required growth rate, while the selected assumptions produce a Max Entry Price below the current spot. This is not an investment recommendation.",
  };
}

export function napkinPathCase(input: {
  eps: number | null | undefined;
  price: number | null | undefined;
  pe: number | null | undefined;
  expected_cagr: number | null | undefined;
  exit_pe: number | null | undefined;
  target_return: number | null | undefined;
  years?: number;
  factor?: number | null;
}): {
  required_cagr: number | null;
  growth_gap: number | null;
  return_gap: number | null;
  max_pay_vs_spot: number | null;
  case: NapkinBuyCase;
} {
  const years = input.years && input.years > 0 ? input.years : 5;
  const required = napkinRequiredEpsCagr(
    input.pe,
    input.factor ?? NAPKIN_FACTOR_DEFAULT,
    years,
  );
  const row = napkinBuyCase({
    eps: input.eps,
    price: input.price,
    expected_cagr: input.expected_cagr,
    exit_pe: input.exit_pe,
    target_return: input.target_return,
    years,
  });
  const expected = finite(input.expected_cagr);
  const target = finite(input.target_return);
  return {
    required_cagr: required,
    growth_gap:
      expected != null && required != null ? expected - required : null,
    return_gap:
      row.implied_cagr != null && target != null
        ? row.implied_cagr - target
        : null,
    max_pay_vs_spot: napkinMaxPayVsSpot(row.buy_price, input.price),
    case: row,
  };
}

export function napkinFactorSensitivityRows(input: {
  pe: number | null | undefined;
  expected_cagr: number | null | undefined;
  eps: number | null | undefined;
  price: number | null | undefined;
  exit_pe: number | null | undefined;
  target_return: number | null | undefined;
  years?: number;
  current_factor?: number;
}): Array<{
  factor: number;
  required_cagr: number | null;
  max_pay: number | null;
  vs_spot: number | null;
  current: boolean;
}> {
  const current = input.current_factor ?? NAPKIN_FACTOR_DEFAULT;
  const years = input.years && input.years > 0 ? input.years : 5;
  const path = napkinBuyCase({
    eps: input.eps,
    price: input.price,
    expected_cagr: input.expected_cagr,
    exit_pe: input.exit_pe,
    target_return: input.target_return,
    years,
  });
  return NAPKIN_FACTOR_PRESETS.map((factor) => ({
    factor,
    required_cagr: napkinRequiredEpsCagr(input.pe, factor, years),
    max_pay: path.buy_price,
    vs_spot: napkinMaxPayVsSpot(path.buy_price, input.price),
    current: Math.abs(factor - current) < 1e-9,
  }));
}

export function napkinExpectedCagrSensitivityRows(input: {
  eps: number | null | undefined;
  price: number | null | undefined;
  exit_pe: number | null | undefined;
  target_return: number | null | undefined;
  years?: number;
  current_cagr: number;
}): Array<{
  expected_cagr: number;
  future_eps: number | null;
  future_value: number | null;
  price_cagr: number | null;
  max_pay: number | null;
  vs_spot: number | null;
  current: boolean;
}> {
  const years = input.years && input.years > 0 ? input.years : 5;
  return NAPKIN_EXPECTED_CAGR_1D.map((cagr) => {
    const row = napkinBuyCase({
      eps: input.eps,
      price: input.price,
      expected_cagr: cagr,
      exit_pe: input.exit_pe,
      target_return: input.target_return,
      years,
    });
    return {
      expected_cagr: cagr,
      future_eps: row.future_eps,
      future_value: row.future_price,
      price_cagr: row.implied_cagr,
      max_pay: row.buy_price,
      vs_spot: napkinMaxPayVsSpot(row.buy_price, input.price),
      current: Math.abs(cagr - input.current_cagr) < 1e-9,
    };
  });
}

export function napkinExitPeLadder(selected: number): number[] {
  const s = finite(selected);
  if (s == null || s <= 0) return [];
  const raw = [s - 15, s - 10, s - 5, s, s + 5, s + 10, s + 15]
    .map((v) => Math.round(v * 10) / 10)
    .filter((v) => v > 1);
  return [...new Set(raw)];
}

export function napkinExitPeSensitivityRows(input: {
  eps: number | null | undefined;
  price: number | null | undefined;
  expected_cagr: number | null | undefined;
  target_return: number | null | undefined;
  years?: number;
  current_exit_pe: number;
}): Array<{
  exit_pe: number;
  future_value: number | null;
  price_cagr: number | null;
  max_pay: number | null;
  vs_spot: number | null;
  current: boolean;
}> {
  const years = input.years && input.years > 0 ? input.years : 5;
  return napkinExitPeLadder(input.current_exit_pe).map((pe) => {
    const row = napkinBuyCase({
      eps: input.eps,
      price: input.price,
      expected_cagr: input.expected_cagr,
      exit_pe: pe,
      target_return: input.target_return,
      years,
    });
    return {
      exit_pe: pe,
      future_value: row.future_price,
      price_cagr: row.implied_cagr,
      max_pay: row.buy_price,
      vs_spot: napkinMaxPayVsSpot(row.buy_price, input.price),
      current: Math.abs(pe - input.current_exit_pe) < 0.05,
    };
  });
}
