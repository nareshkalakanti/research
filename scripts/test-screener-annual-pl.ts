import { parseScreenerAnnualPlHtml } from "../src/lib/screener-annual";

const html = `
<section id="profit-loss">
  <table>
    <thead>
      <tr>
        <th></th>
        <th>Mar 2022</th>
        <th>Mar 2023</th>
        <th>Mar 2024</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><button type="button">+</button> Sales</td>
        <td>1,433</td><td>1,572</td><td>1,448</td>
      </tr>
      <tr>
        <td>Sales Growth %</td>
        <td>12</td><td>10</td><td>-8</td>
      </tr>
      <tr>
        <td><button type="button">+</button> Expenses</td>
        <td>1,275</td><td>1,425</td><td>1,320</td>
      </tr>
      <tr>
        <td>Operating Profit</td>
        <td>158</td><td>147</td><td>128</td>
      </tr>
      <tr>
        <td>Profit before tax</td>
        <td>102</td><td>86</td><td>70</td>
      </tr>
      <tr>
        <td>Tax %</td>
        <td>29</td><td>27</td><td>28</td>
      </tr>
      <tr>
        <td><button type="button">+</button> Net Profit</td>
        <td>72</td><td>63</td><td>50</td>
      </tr>
      <tr>
        <td>EPS in Rs</td>
        <td>23.4</td><td>20.3</td><td>16.0</td>
      </tr>
    </tbody>
  </table>
</section>
`;

const pl = parseScreenerAnnualPlHtml(html);
const fail = (msg: string) => {
  console.error(msg, JSON.stringify(pl, null, 2));
  process.exit(1);
};

if (pl.revenue[0] !== 1433 || pl.revenue[1] !== 1572) {
  fail("Sales must come from the Sales row, not Sales Growth %");
}
if (pl.pat[0] !== 72 || pl.pat[2] !== 50) {
  fail("Net Profit must parse from the + button row");
}
if (pl.operating_profit[0] !== 158) fail("Operating Profit");
if (pl.expenses[0] !== 1275) fail("Expenses");

const plusPrefix = html.replace(
  `<td><button type="button">+</button> Sales</td>`,
  `<td>+ Sales</td>`,
);
const pl2 = parseScreenerAnnualPlHtml(plusPrefix);
if (pl2.revenue[0] !== 1433) fail("+ Sales prefix must still map to revenue");

const nestedBtn = html.replace(
  `<td><button type="button">+</button> Sales</td>`,
  `<td><button>Sales&nbsp;<span>+</span></button></td>`,
).replace(
  `<td><button type="button">+</button> Expenses</td>`,
  `<td><button>Expenses&nbsp;<span>+</span></button></td>`,
).replace(
  `<td><button type="button">+</button> Net Profit</td>`,
  `<td><button>Net Profit&nbsp;<span>+</span></button></td>`,
);
const pl3 = parseScreenerAnnualPlHtml(nestedBtn);
if (pl3.revenue[0] !== 1433 || pl3.pat[0] !== 72 || pl3.expenses[0] !== 1275) {
  fail("Sales/Expenses/Net Profit inside + button");
}
