import assert from "node:assert/strict";
import { napkinAnalysis, napkinScreenVerdict } from "../src/lib/napkin/engine";

function close(a: number | null, b: number, d = 1e-12) {
  assert.ok(a != null && Math.abs(a - b) < d, `${a} ≉ ${b}`);
}

const defaults = {
  near_term_ratio: 0.3,
  years: 5,
  adjustment_factor: 4.5 / 34.5,
};

const nelco = napkinAnalysis(
  {
    current_pe: 34.5,
    historical_eps_cagr_3y: 0.2,
    historical_eps_cagr_5y: 0.1,
  },
  defaults,
);
close(nelco.near_term_value, 10.35);
close(nelco.basic_required_cagr, 10.35 ** (1 / 5) - 1);
close(nelco.adjusted_value, 4.5);
close(nelco.adjusted_required_cagr, 4.5 ** (1 / 5) - 1);
assert.ok(
  Math.abs((nelco.basic_required_cagr ?? 0) * 100 - 59.6) < 0.05,
  "basic ~59.6% (published ~59.8% rounding)",
);
assert.ok(
  Math.abs((nelco.adjusted_required_cagr ?? 0) * 100 - 35.1) < 0.05,
  "adjusted ~35.1% (published ~35.0% rounding)",
);
close(nelco.growth_gap_3y, 0.2 - nelco.basic_required_cagr!);
close(nelco.growth_gap_5y, 0.1 - nelco.basic_required_cagr!);

const pe348 = napkinAnalysis(
  {
    current_pe: 34.8,
    historical_eps_cagr_3y: null,
    historical_eps_cagr_5y: null,
  },
  defaults,
);
close(pe348.basic_required_cagr, (34.8 * 0.3) ** (1 / 5) - 1);
assert.ok(
  Math.abs((pe348.basic_required_cagr ?? 0) * 100 - 59.9) < 0.15,
  "Math.pow(pe * 0.30, 1/5) - 1 at 34.8x is ~59.9%, not ~27.9%",
);

const pe175 = napkinAnalysis(
  {
    current_pe: 17.5,
    historical_eps_cagr_3y: null,
    historical_eps_cagr_5y: null,
    expected_eps_cagr: 0.22,
  },
  defaults,
);
close(pe175.basic_required_cagr, (17.5 * 0.3) ** (1 / 5) - 1);
close(pe175.adjusted_required_cagr, (17.5 * (4.5 / 34.5)) ** (1 / 5) - 1);
assert.ok(Math.abs((pe175.basic_required_cagr ?? 0) * 100 - 39.3) < 0.05);
assert.ok(Math.abs((pe175.adjusted_required_cagr ?? 0) * 100 - 17.9) < 0.05);
close(pe175.growth_gap_expected_adjusted, 0.22 - pe175.adjusted_required_cagr!);
close(pe175.growth_gap_expected_basic, 0.22 - pe175.basic_required_cagr!);
assert.ok(Math.abs((pe175.growth_gap_expected_adjusted ?? 0) * 100 - 4.1) < 0.05);

const missing = napkinAnalysis({
  current_pe: null,
  historical_eps_cagr_3y: null,
  historical_eps_cagr_5y: 0.12,
});
assert.equal(missing.basic_required_cagr, null);
assert.equal(missing.adjusted_required_cagr, null);
assert.equal(missing.growth_gap_3y, null);
assert.equal(missing.growth_gap_expected_adjusted, null);

const custom = napkinAnalysis(
  { current_pe: 20, historical_eps_cagr_3y: null, historical_eps_cagr_5y: null },
  { near_term_ratio: 0.25, years: 4, adjustment_factor: 0.2 },
);
assert.equal(custom.near_term_value, 5);
assert.equal(custom.adjusted_value, 4);
assert.equal(custom.config.years, 4);

assert.equal(napkinScreenVerdict(null), "INSUFFICIENT DATA");
assert.equal(napkinScreenVerdict(0.12), "PASS");
assert.equal(napkinScreenVerdict(0), "HOLD");
assert.equal(napkinScreenVerdict(-0.1), "HOLD");
assert.equal(napkinScreenVerdict(-0.11), "FAIL");
assert.equal(napkinScreenVerdict(-1.997), "FAIL");
assert.equal(
  napkinScreenVerdict(0.05, { pass_gap_pp: 20, hold_min_gap_pp: -5 }),
  "HOLD",
);

const screenFail = napkinAnalysis(
  {
    current_pe: 538.9,
    historical_eps_cagr_3y: -0.45,
    historical_eps_cagr_5y: -0.232,
  },
  { near_term_ratio: 0.3, years: 5, pass_gap_pp: 10, hold_min_gap_pp: -10 },
);
assert.equal(screenFail.screen_verdict, "FAIL");

console.log("ok");
