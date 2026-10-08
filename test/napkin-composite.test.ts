/**
 *   npx tsx test/napkin-composite.test.ts
 */
import assert from "node:assert/strict";
import {
  napkinCompositeVerdict,
  napkinEntryPriceStatus,
  napkinExitPeLadder,
  napkinFactorSensitivityRows,
  napkinMaxPayVsSpot,
  napkinPathCase,
} from "../src/lib/napkin/composite";
import { napkinBuyCase } from "../src/lib/napkin/buy-price";
import { napkinRequiredEpsCagr } from "../src/lib/napkin/engine";

const eps = 31.1;
const pe = 34.8;
const price = 1082;
const growth = 0.15;
const target = 0.15;
const years = 5;

const required = napkinRequiredEpsCagr(pe);
const row = napkinBuyCase({
  eps,
  price,
  expected_cagr: growth,
  exit_pe: pe,
  target_return: target,
  years,
});
const path = napkinPathCase({
  eps,
  price,
  pe,
  expected_cagr: growth,
  exit_pe: pe,
  target_return: target,
  years,
});
assert.equal(path.required_cagr, required);
assert.equal(path.case.buy_price, row.buy_price);
assert.ok(
  Math.abs((path.max_pay_vs_spot ?? 0) - (row.buy_price! / price - 1)) < 1e-12,
);
assert.equal(napkinMaxPayVsSpot(row.buy_price, price), path.max_pay_vs_spot);

assert.equal(napkinEntryPriceStatus(price, price)?.label, "AT ENTRY PRICE");
assert.equal(napkinEntryPriceStatus(900, 1000)?.label, "WITHIN ENTRY RANGE");
assert.equal(napkinEntryPriceStatus(1050, 1000)?.label, "NEAR ENTRY PRICE");
assert.equal(napkinEntryPriceStatus(1300, 1000)?.label, "ABOVE ENTRY PRICE");
assert.equal(napkinEntryPriceStatus(price, null), null);

assert.equal(
  napkinCompositeVerdict({
    expected_cagr: 0.2,
    required_cagr: 0.15,
    price_cagr: 0.18,
    target_return: 0.15,
    max_pay: 1100,
    price: 1000,
  })?.label,
  "ATTRACTIVE",
);
assert.equal(
  napkinCompositeVerdict({
    expected_cagr: 0.08,
    required_cagr: 0.15,
    price_cagr: 0.12,
    target_return: 0.15,
    max_pay: 950,
    price: 1000,
  })?.label,
  "REASONABLE",
);
assert.equal(
  napkinCompositeVerdict({
    expected_cagr: 0.05,
    required_cagr: 0.4,
    price_cagr: 0.02,
    target_return: 0.15,
    max_pay: 700,
    price: 1000,
  })?.label,
  "HIGHLY STRETCHED",
);
assert.equal(
  napkinCompositeVerdict({
    expected_cagr: 0.05,
    required_cagr: 0.25,
    price_cagr: 0.02,
    target_return: 0.15,
    max_pay: 820,
    price: 1000,
  })?.label,
  "STRETCHED",
);
assert.equal(
  napkinCompositeVerdict({
    expected_cagr: 0.15,
    required_cagr: null,
    price_cagr: 0.15,
    target_return: 0.15,
    max_pay: 1000,
    price: 1000,
  }),
  null,
);

const factors = napkinFactorSensitivityRows({
  pe,
  expected_cagr: growth,
  eps,
  price,
  exit_pe: pe,
  target_return: target,
  years,
});
assert.equal(factors.length, 5);
assert.equal(factors[2]!.current, true);
assert.equal(factors[0]!.max_pay, factors[2]!.max_pay);
assert.ok((factors[0]!.required_cagr ?? 0) < (factors[4]!.required_cagr ?? 0));

assert.deepEqual(napkinExitPeLadder(55.3), [40.3, 45.3, 50.3, 55.3, 60.3, 65.3, 70.3]);
