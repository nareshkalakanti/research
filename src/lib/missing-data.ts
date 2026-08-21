import { loadAllCompanies } from "@/lib/db";
import {
  loadFundWatchlistStubs,
  negenTickerSet,
  niveshaayTickerSet,
} from "@/lib/fund-watchlists";
import { researchLinks } from "@/lib/links";

export type MissingGapKey =
  | "metrics"
  | "price"
  | "mcap"
  | "sector"
  | "sub_sector"
  | "about"
  | "web"
  | "any";

export type GapFlags = {
  price: boolean;
  mcap: boolean;
  sector: boolean;
  sub_sector: boolean;
  about: boolean;
  web: boolean;
};

type CompanyLike = {
  price: number | null;
  mcap_cr: number | null;
  sector: string | null;
  sub_sector: string | null;
  about: string | null;
  web: string | null;
};

export function companyGapFlags(c: CompanyLike): GapFlags {
  return {
    price: c.price == null,
    mcap: c.mcap_cr == null,
    sector: !c.sector?.trim(),
    sub_sector: !c.sub_sector?.trim(),
    about: !c.about?.trim(),
    web: !c.web,
  };
}

export function matchesMissingGap(
  g: GapFlags,
  missing: string,
): boolean {
  const key = missing.trim().toLowerCase();
  if (key === "any") {
    return (
      g.price || g.mcap || g.sector || g.sub_sector || g.about || g.web
    );
  }
  if (key === "price") return g.price;
  if (key === "mcap") return g.mcap;
  if (key === "sector") return g.sector || g.sub_sector;
  if (key === "sub_sector") return g.sub_sector;
  if (key === "about") return g.about;
  if (key === "web") return g.web;
  if (key === "metrics") return g.price || g.mcap;
  return g.price || g.mcap;
}

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

function appendFundWatchlistStubs(
  companies: ReturnType<typeof loadAllCompanies>,
  tickers: Set<string>,
  all: ReturnType<typeof loadAllCompanies>,
) {
  if (!tickers.size) return companies;
  const byTicker = new Map(all.map((c) => [c.ticker.toUpperCase(), c]));
  const have = new Set(companies.map((c) => c.ticker.toUpperCase()));
  const out = [...companies];
  for (const listKey of ["niveshaay", "negen"] as const) {
    for (const stub of loadFundWatchlistStubs(listKey, have)) {
      if (!tickers.has(stub.ticker.toUpperCase())) continue;
      out.push(byTicker.get(stub.ticker.toUpperCase()) ?? fundStubRow(stub));
      have.add(stub.ticker.toUpperCase());
    }
  }
  return out;
}

function mergeFundWatchlistUniverse(
  companies: ReturnType<typeof loadAllCompanies>,
  all: ReturnType<typeof loadAllCompanies>,
  fund: { niveshaay: Set<string>; negen: Set<string> },
) {
  const fundAll = new Set([...fund.niveshaay, ...fund.negen]);
  if (!fundAll.size) return companies;
  const byTicker = new Map(companies.map((c) => [c.ticker.toUpperCase(), c]));
  for (const c of all) {
    const t = c.ticker.toUpperCase();
    if (fundAll.has(t)) byTicker.set(t, c);
  }
  return appendFundWatchlistStubs([...byTicker.values()], fundAll, all);
}

/** Missing-data tab universe: list + gap filter (matches /api/companies). */
export function loadMissingCompanies(
  market: string,
  missing: string,
): ReturnType<typeof loadAllCompanies> {
  const allCompanies = loadAllCompanies();
  let companies = allCompanies;

  if (market && market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }

  companies = mergeFundWatchlistUniverse(companies, allCompanies, {
    niveshaay: niveshaayTickerSet(),
    negen: negenTickerSet(),
  });

  return companies
    .filter((c) => matchesMissingGap(companyGapFlags(c), missing))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
