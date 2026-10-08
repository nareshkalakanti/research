/**
 * Prefer the Screener annual P&L table with more fiscal years (consolidated vs standalone).
 */
import assert from "node:assert/strict";
import {
  parseScreenerAnnualPlHtml,
  pickRicherScreenerAnnualPl,
} from "../src/lib/screener-annual";

function plHtml(dates: string[], sales: number[]): string {
  const th = dates
    .map((d) => {
      const y = d.slice(0, 4);
      return `<th data-date-key="${d}">Mar ${y}</th>`;
    })
    .join("");
  const td = (vals: number[]) => vals.map((v) => `<td>${v}</td>`).join("");
  return `
<section id="profit-loss">
  <table class="data-table">
    <thead><tr><th></th>${th}</tr></thead>
    <tbody>
      <tr><td>Sales</td>${td(sales)}</tr>
      <tr><td>Operating Profit</td>${td(sales.map((s) => Math.round(s * 0.1)))}</tr>
      <tr><td>Net Profit</td>${td(sales.map((s) => Math.round(s * 0.05)))}</tr>
      <tr><td>EPS in Rs</td>${td(sales.map((_, i) => i + 1))}</tr>
    </tbody>
  </table>
</section>`;
}

const short = parseScreenerAnnualPlHtml(
  plHtml(["2020-03-31", "2021-03-31", "2022-03-31"], [10, 20, 30]),
);
const long = parseScreenerAnnualPlHtml(
  plHtml(
    [
      "2017-03-31",
      "2018-03-31",
      "2019-03-31",
      "2020-03-31",
      "2021-03-31",
      "2022-03-31",
    ],
    [5, 6, 7, 10, 20, 30],
  ),
);
assert.equal(short.dates.length, 3);
assert.equal(long.dates.length, 6);
assert.equal(pickRicherScreenerAnnualPl(short, long).dates.length, 6);
assert.equal(pickRicherScreenerAnnualPl(long, short).dates.length, 6);
