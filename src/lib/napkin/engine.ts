/**
 * Numerical napkin required-CAGR and a configurable growth-gap screen.
 * Screening labels are a convention, not an investment recommendation.
 * No issuer forks.
 *
 * Basic hurdle:  (current_pe * near_term_ratio)^(1/years) - 1
 * Growth gap = historical EPS CAGR − required CAGR (ratio).
 * Screen uses gap in percentage points vs pass_gap_pp / hold_min_gap_pp.
 */

export type NapkinScreenVerdict =
  | "PASS"
  | "HOLD"
  | "FAIL"
  | "INSUFFICIENT DATA";

export type NapkinEngineConfig = {
  terminal_value_ratio: number | null;
  near_term_ratio: number;
  years: number;
  adjustment_factor: number | null;
  /** PASS when growth gap (pp) is at least this. Default 10. */
  pass_gap_pp: number;
  /** HOLD when growth gap (pp) is at least this and below pass. Default -10. */
  hold_min_gap_pp: number;
};

function envNum(key: string): number | null {
  const raw = process.env[key]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function napkinConfigFromEnv(): Partial<NapkinEngineConfig> {
  const out: Partial<NapkinEngineConfig> = {};
  const ratio = envNum("NAPKIN_NEAR_TERM_RATIO");
  const years = envNum("NAPKIN_YEARS");
  const factor = envNum("NAPKIN_ADJUSTMENT_FACTOR");
  const multiple = envNum("NAPKIN_ADJUSTED_MULTIPLE");
  const pe = envNum("NAPKIN_ADJUSTED_PE");
  if (ratio != null && ratio > 0) out.near_term_ratio = ratio;
  if (years != null && years > 0) out.years = years;
  if (factor != null && factor > 0) out.adjustment_factor = factor;
  else if (multiple != null && pe != null && pe > 0) {
    out.adjustment_factor = multiple / pe;
  }
  const passPp = envNum("NAPKIN_PASS_GAP_PP");
  const holdPp = envNum("NAPKIN_HOLD_MIN_GAP_PP");
  if (passPp != null) out.pass_gap_pp = passPp;
  if (holdPp != null) out.hold_min_gap_pp = holdPp;
  return out;
}

/** Worksheet defaults. 4.5/34.5 is optional reproduction config. */
export const DEFAULT_NAPKIN_CONFIG: NapkinEngineConfig = {
  terminal_value_ratio: null,
  near_term_ratio: 0.3,
  years: 5,
  adjustment_factor: 4.5 / 34.5,
  pass_gap_pp: 10,
  hold_min_gap_pp: -10,
};

export type NapkinEngineInput = {
  current_pe: number | null | undefined;
  historical_eps_cagr_3y: number | null | undefined;
  historical_eps_cagr_5y: number | null | undefined;
  expected_eps_cagr?: number | null | undefined;
};

export type NapkinEngineResult = {
  current_pe: number | null;
  near_term_value: number | null;
  adjusted_value: number | null;
  basic_required_cagr: number | null;
  adjusted_required_cagr: number | null;
  historical_eps_cagr_3y: number | null;
  historical_eps_cagr_5y: number | null;
  expected_eps_cagr: number | null;
  growth_gap_3y: number | null;
  growth_gap_5y: number | null;
  growth_gap_hist_adjusted_5y: number | null;
  growth_gap_expected_basic: number | null;
  growth_gap_expected_adjusted: number | null;
  screen_gap: number | null;
  screen_verdict: NapkinScreenVerdict;
  screen_note: string;
  config: NapkinEngineConfig;
};

function finite(v: number | null | undefined): number | null {
  if (v == null || typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function requiredCagr(multiple: number | null, years: number): number | null {
  if (multiple == null || years <= 0) return null;
  if (multiple <= 0) return null;
  return multiple ** (1 / years) - 1;
}

function gap(expected: number | null, required: number | null): number | null {
  if (expected == null || required == null) return null;
  return expected - required;
}

export function napkinScreenNote(verdict: NapkinScreenVerdict): string {
  if (verdict === "PASS") {
    return "Required CAGR is comfortably below historical EPS CAGR";
  }
  if (verdict === "HOLD") {
    return "Required CAGR is close to historical EPS CAGR — valuation needs continued execution";
  }
  if (verdict === "FAIL") {
    return "Required CAGR is materially above historical EPS CAGR";
  }
  return "Important financial/valuation inputs are missing";
}

export function napkinScreenVerdict(
  gapRatio: number | null | undefined,
  config: Pick<NapkinEngineConfig, "pass_gap_pp" | "hold_min_gap_pp"> = DEFAULT_NAPKIN_CONFIG,
): NapkinScreenVerdict {
  if (gapRatio == null || !Number.isFinite(gapRatio)) return "INSUFFICIENT DATA";
  const pp = gapRatio * 100;
  if (pp >= config.pass_gap_pp) return "PASS";
  if (pp >= config.hold_min_gap_pp) return "HOLD";
  return "FAIL";
}

export function napkinAnalysis(
  input: NapkinEngineInput,
  config: Partial<NapkinEngineConfig> = {},
): NapkinEngineResult {
  const cfg: NapkinEngineConfig = {
    ...DEFAULT_NAPKIN_CONFIG,
    ...napkinConfigFromEnv(),
    ...config,
  };
  const pe = finite(input.current_pe);
  const hist3 = finite(input.historical_eps_cagr_3y);
  const hist5 = finite(input.historical_eps_cagr_5y);
  const expected = finite(input.expected_eps_cagr);

  const nearTerm =
    pe != null && pe > 0 && cfg.near_term_ratio > 0
      ? pe * cfg.near_term_ratio
      : null;

  const factor = finite(cfg.adjustment_factor);
  let adjusted: number | null = null;
  if (pe != null && pe > 0 && factor != null && factor > 0) {
    const terminal = finite(cfg.terminal_value_ratio);
    adjusted = terminal != null ? pe * factor * terminal : pe * factor;
  }

  const basic = requiredCagr(nearTerm, cfg.years);
  const adjCagr = requiredCagr(adjusted, cfg.years);
  const gap3 = gap(hist3, basic);
  const gap5 = gap(hist5, basic);
  const screenGap = hist5 != null ? gap5 : gap3;
  const screen_verdict = napkinScreenVerdict(screenGap, cfg);

  return {
    current_pe: pe != null && pe > 0 ? pe : null,
    near_term_value: nearTerm,
    adjusted_value: adjusted,
    basic_required_cagr: basic,
    adjusted_required_cagr: adjCagr,
    historical_eps_cagr_3y: hist3,
    historical_eps_cagr_5y: hist5,
    expected_eps_cagr: expected,
    growth_gap_3y: gap3,
    growth_gap_5y: gap5,
    growth_gap_hist_adjusted_5y: gap(hist5, adjCagr),
    growth_gap_expected_basic: gap(expected, basic),
    growth_gap_expected_adjusted: gap(expected, adjCagr),
    screen_gap: screenGap,
    screen_verdict,
    screen_note: napkinScreenNote(screen_verdict),
    config: cfg,
  };
}
