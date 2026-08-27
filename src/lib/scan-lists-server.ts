import { edgeTickerSet } from "@/lib/edge";
import {
  FUND_WATCHLIST_KEYS,
  fundKeyFromScanList,
} from "@/lib/fund-watchlist-meta";
import {
  fundTickerSet,
  loadFundWatchlistStubs,
} from "@/lib/fund-watchlists";
import { holdingsTickerSet } from "@/lib/holdings";
import { researchLinks } from "@/lib/links";

function fundStubRow(stub: {
  ticker: string;
  name: string;
  market: string;
}) {
  const links = researchLinks(stub.ticker, stub.market, null);
  const name = stub.name?.trim() || stub.ticker;
  return {
    ticker: stub.ticker,
    name,
    market: stub.market,
    website: null,
    about: null,
    scraped_about: null,
    scrape_source_url: null,
    headquarters: null,
    sector: null,
    sub_sector: null,
    price: null,
    mcap_cr: null,
    search_text: `${stub.ticker} ${name}`.toLowerCase(),
    web: links.web,
    sc: links.sc,
    tv: links.tv,
  };
}

function appendFundStubs<T extends { ticker: string }>(
  companies: T[],
  tickers: Set<string>,
  allCompanies: T[],
  fundStubFactory: (stub: { ticker: string; name: string; market: string }) => T,
): T[] {
  if (!tickers.size) return companies;
  const byTicker = new Map(allCompanies.map((c) => [c.ticker.toUpperCase(), c]));
  const have = new Set(companies.map((c) => c.ticker.toUpperCase()));
  const out = [...companies];
  for (const listKey of FUND_WATCHLIST_KEYS) {
    for (const stub of loadFundWatchlistStubs(listKey, have)) {
      if (!tickers.has(stub.ticker.toUpperCase())) continue;
      out.push(byTicker.get(stub.ticker.toUpperCase()) ?? fundStubFactory(stub));
      have.add(stub.ticker.toUpperCase());
    }
  }
  return out;
}

export function filterCompaniesByScanList<T extends { ticker: string; market: string }>(
  companies: T[],
  list: string,
  allCompanies?: T[],
  fundStubFactory?: (stub: { ticker: string; name: string; market: string }) => T,
): T[] {
  if (!list || list === "All") return companies;

  if (list === "NSE") {
    return companies.filter(
      (c) => c.market === "NSE" || c.market === "NSE SME",
    );
  }
  if (list === "NSE SME" || list === "BSE SME") {
    return companies.filter((c) => c.market === list);
  }

  const universe = allCompanies ?? companies;
  const holdings = holdingsTickerSet();
  const edge = edgeTickerSet();

  if (list === "Hold") {
    return companies.filter((c) => holdings.has(c.ticker.toUpperCase()));
  }
  if (list === "Edge") {
    return companies.filter((c) => edge.has(c.ticker.toUpperCase()));
  }

  const fundKey = fundKeyFromScanList(list);
  if (fundKey) {
    const tickers = fundTickerSet(fundKey);
    let rows = companies.filter((c) => tickers.has(c.ticker.toUpperCase()));
    if (fundStubFactory) {
      rows = appendFundStubs(rows, tickers, universe, fundStubFactory);
    }
    return rows;
  }

  return companies.filter((c) => c.market === list);
}
