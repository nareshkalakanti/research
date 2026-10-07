/**
 * Screener top-ratios parser — Market Cap / Stock P/E / ROE / ROCE.
 */
import assert from "node:assert/strict";
import { parseScreenerTopRatios } from "../src/lib/screener-ratios";

const SAMPLE = `
<div id="top-ratios">
  <li class="flex flex-space-between">
    <span class="name">Market Cap</span>
    <span class="nowrap value">₹ <span class="number">1,555</span> Cr.</span>
  </li>
  <li class="flex flex-space-between">
    <span class="name">Current Price</span>
    <span class="nowrap value">₹ <span class="number">1,750</span></span>
  </li>
  <li class="flex flex-space-between">
    <span class="name">Stock P/E</span>
    <span class="nowrap value"><span class="number">49.2</span></span>
  </li>
  <li class="flex flex-space-between">
    <span class="name">ROCE</span>
    <span class="nowrap value"><span class="number">58.9</span> %</span>
  </li>
  <li class="flex flex-space-between">
    <span class="name">ROE</span>
    <span class="nowrap value"><span class="number">54.9</span> %</span>
  </li>
</div>
`;

const r = parseScreenerTopRatios(SAMPLE);
assert.equal(r.market_cap_cr, 1555);
assert.equal(r.current_price, 1750);
assert.equal(r.stock_pe, 49.2);
assert.ok(r.roce != null && Math.abs(r.roce - 0.589) < 1e-9);
assert.ok(r.roe != null && Math.abs(r.roe - 0.549) < 1e-9);

const empty = parseScreenerTopRatios("<html>captcha access denied</html>");
assert.equal(empty.market_cap_cr, null);
assert.equal(empty.stock_pe, null);

console.log("screener-ratios.test.ts: ok");
