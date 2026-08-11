/**
 * Unit checks for news relevance filtering.
 * Usage: npx tsx scripts/test-news-relevance.ts
 */
import {
  headlineMatchesCompany,
  companyMatchPhrases,
} from "../src/lib/hidden-portfolio/news_scanner";

const cases: Array<{
  title: string;
  name: string;
  symbol: string;
  expect: boolean;
}> = [
  {
    title: "Sarfaraz Khan in, Dhruv Jurel out for IND vs SL Tests",
    name: "Dhruv Consultancy Services Limited",
    symbol: "DHRUV.NS",
    expect: false,
  },
  {
    title: "Dhruv Consultancy wins NHAI road contract worth Rs 120 crore",
    name: "Dhruv Consultancy Services Limited",
    symbol: "DHRUV.NS",
    expect: true,
  },
  {
    title: "Atam Valves bags export order from Middle East",
    name: "Atam Valves",
    symbol: "ATAM.NS",
    expect: true,
  },
  {
    title: "IIIT professor develops ATAM dance teaching tool",
    name: "Atam Valves",
    symbol: "ATAM.NS",
    expect: false,
  },
];

let ok = 0;
for (const c of cases) {
  const got = headlineMatchesCompany(c.title, c.name, c.symbol);
  const pass = got === c.expect;
  if (pass) ok += 1;
  console.log(pass ? "✓" : "✗", c.symbol, got, "—", c.title.slice(0, 60));
}

console.log(`\n${ok}/${cases.length} passed`);
console.log(
  "DHRUV phrases:",
  companyMatchPhrases("Dhruv Consultancy Services Limited"),
);
process.exit(ok === cases.length ? 0 : 1);
