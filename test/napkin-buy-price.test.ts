/**
 *   npx tsx test/napkin-buy-price.test.ts
 */
import assert from "node:assert/strict";
import {
  NAPKIN_BUY_SENSITIVITY_PES,
  napkinBuyCase,
  napkinBuyPricePosition,
  NAPKIN_EXIT_PE_CAP,
  NAPKIN_HIST_GROWTH_MAX,
  NAPKIN_HIST_GROWTH_MIN,
  napkinDefaultExitPe,
  napkinDefaultGrowth,
  napkinDefaultMaxBuyPrice,
  napkinIllustrativeBuyRows,
} from "../src/lib/napkin/buy-price";
import { napkinRequiredEpsCagr } from "../src/lib/napkin/engine";

const eps = 31.1;
const pe = 34.8;
const price = 1082;
const growth = 0.15;
const target = 0.15;
const futureEps = eps * Math.pow(1 + growth, 5);
const futurePrice = futureEps * pe;
const buy = futurePrice / Math.pow(1 + target, 5);

const row = napkinBuyCase({
  eps,
  price,
  expected_cagr: growth,
  exit_pe: pe,
  target_return: target,
});
assert.ok(Math.abs((row.future_eps ?? 0) - futureEps) < 1e-9);
assert.ok(Math.abs((row.future_price ?? 0) - futurePrice) < 1e-9);
assert.ok(Math.abs((row.buy_price ?? 0) - buy) < 1e-9);
assert.ok(Math.abs((row.upside ?? 0) - (futurePrice / price - 1)) < 1e-12);
assert.ok(
  Math.abs((row.implied_cagr ?? 0) - (Math.pow(futurePrice / price, 1 / 5) - 1)) <
    1e-12,
);
assert.ok(Math.abs((row.price_gap ?? 0) - (buy / price - 1)) < 1e-12);
assert.ok(Math.abs(futureEps - 62.55) < 0.02);
assert.ok(Math.abs(futurePrice - 2177) < 1);
assert.ok(Math.abs(buy - 1082) < 1);
// Default: no history -> 15% growth, exit P/E capped at 25x (current 34.8x).
const cappedBuy = (eps * Math.pow(1.15, 5) * NAPKIN_EXIT_PE_CAP) / Math.pow(1.15, 5);
assert.ok(Math.abs((napkinDefaultMaxBuyPrice({ eps, price, pe }) ?? 0) - cappedBuy) < 1e-9);
// History drives growth, kept within 0–30%.
assert.equal(napkinDefaultGrowth(0.08), 0.08);
assert.equal(napkinDefaultGrowth(-0.2), NAPKIN_HIST_GROWTH_MIN);
assert.equal(napkinDefaultGrowth(0.9), NAPKIN_HIST_GROWTH_MAX);
assert.equal(napkinDefaultGrowth(null), 0.15);
assert.equal(napkinDefaultExitPe(18), 18);
assert.equal(napkinDefaultExitPe(40), NAPKIN_EXIT_PE_CAP);
assert.equal(napkinDefaultExitPe(-5), null);
// Regression: defaults must not collapse to "max entry = price" for every stock.
{
  const e = 10, p2 = 200; // P/E 20, history 8%
  const b = napkinDefaultMaxBuyPrice({ eps: e, price: p2, pe: 20, historical_cagr: 0.08 }) ?? 0;
  assert.ok(Math.abs(b - (e * Math.pow(1.08, 5) * 20) / Math.pow(1.15, 5)) < 1e-9);
  assert.ok(b < p2 * 0.8);
}
assert.equal(napkinDefaultMaxBuyPrice({ eps: null, price, pe }), null);
assert.equal(napkinDefaultMaxBuyPrice({ eps, price: null, pe }), null);
assert.equal(napkinDefaultMaxBuyPrice({ eps, price, pe: null }), null);
assert.match(
  napkinBuyPricePosition(0) || "",
  /matches your max pay-today/,
);
assert.match(
  napkinBuyPricePosition(buy / price - 1) || "",
  /below your max pay-today/,
);
assert.match(
  napkinBuyPricePosition(0.01) || "",
  /below your max pay-today/,
);
assert.match(
  napkinBuyPricePosition(-0.01) || "",
  /above your max pay-today/,
);
assert.deepEqual(NAPKIN_BUY_SENSITIVITY_PES, [20, 25, 30, 35, 40]);
const scenes = napkinIllustrativeBuyRows({ eps, price, target_return: target });
assert.deepEqual(
  scenes.map((s) => [s.name, s.expected_cagr, s.exit_pe]),
  [
    ["Bear", 0.1, 20],
    ["Base", 0.15, 25],
    ["Bull", 0.25, 30],
  ],
);
const bear = eps * Math.pow(1.1, 5) * 20 / Math.pow(1.15, 5);
assert.ok(Math.abs((scenes[0]!.case.buy_price ?? 0) - bear) < 1e-6);
const required = napkinRequiredEpsCagr(pe);
assert.equal(required, Math.pow(pe * 0.3, 1 / 5) - 1);
assert.ok(required != null && 0.238 - required < 0);

const other = napkinBuyCase({
  eps: 10,
  price: 100,
  expected_cagr: 0.1,
  exit_pe: 20,
  target_return: 0.2,
});
const fEps = 10 * Math.pow(1.1, 5);
const fPx = fEps * 20;
assert.ok(Math.abs((other.buy_price ?? 0) - fPx / Math.pow(1.2, 5)) < 1e-9);

assert.equal(
  napkinBuyCase({
    eps: 0,
    price: 10,
    expected_cagr: 0.1,
    exit_pe: 10,
    target_return: 0.1,
  }).future_eps,
  0,
);
assert.equal(
  napkinBuyCase({
    eps: -2,
    price: 10,
    expected_cagr: 0.1,
    exit_pe: 10,
    target_return: 0.1,
  }).buy_price,
  null,
  "loss-making EPS has no maximum buy price",
);
assert.equal(
  napkinBuyCase({
    eps: 0,
    price: 10,
    expected_cagr: 0.1,
    exit_pe: 10,
    target_return: 0.1,
  }).buy_price,
  null,
);
assert.equal(
  napkinBuyCase({
    eps: null,
    price: 10,
    expected_cagr: 0.1,
    exit_pe: 10,
    target_return: 0.1,
  }).buy_price,
  null,
);

console.log("ok");
