import { loadAllCompanies, type CompanyRow } from "./db";
import {
  rankListingQuery,
  listingQueryMatches,
  listingQueryVariants,
} from "./listing-name-match";
import {
  resolveTickerFromBseScrip,
  tickerFromBseScrip,
} from "./bse-investor-discover";
import { searchGrowwListings } from "./web-mcap";
import type { SectorMember } from "./sector-rotation";

export type ResolvedListing = SectorMember & { query: string; source: string };

function localListings(): CompanyRow[] {
  try {
    return loadAllCompanies();
  } catch {
    return [];
  }
}

async function resolveByBseScrip(
  scrip: string,
): Promise<Omit<ResolvedListing, "query"> | null> {
  const cached = tickerFromBseScrip(scrip);
  if (cached) {
    const row = localListings().find(
      (c) => c.ticker.toUpperCase() === cached,
    );
    return {
      ticker: cached,
      name: row?.name || cached,
      market: String(row?.market || "BSE"),
      source: "bse-scrip",
    };
  }
  try {
    const remote = await searchGrowwListings(scrip, 8);
    const hit = remote.find(
      (r) => (r.bse_scrip || "") === scrip || r.ticker === scrip,
    );
    if (hit) {
      return {
        ticker: hit.ticker,
        name: hit.name,
        market: hit.market || "BSE",
        source: "groww",
      };
    }
  } catch {
    /* BSE identity next */
  }
  try {
    const live = await resolveTickerFromBseScrip(scrip);
    if (live?.ticker) {
      return {
        ticker: live.ticker,
        name: live.name || live.ticker,
        market: "BSE",
        source: "bse-scrip",
      };
    }
  } catch {
    /* unresolved */
  }
  return null;
}

export async function resolveListingQuery(
  query: string,
): Promise<ResolvedListing | null> {
  const q = query.trim();
  if (q.length < 2) return null;
  if (/^\d{5,7}$/.test(q)) {
    const fromScrip = await resolveByBseScrip(q);
    if (fromScrip) return { ...fromScrip, query: q };
  }
  type Cand = SectorMember & { source: string; rank: number };
  const cands: Cand[] = [];
  const have = new Set<string>();
  const push = (row: SectorMember, source: string) => {
    let ticker = row.ticker.toUpperCase();
    let name = row.name;
    let market = row.market;
    const stem = ticker.replace(/-(?:RE|PP)$/i, "");
    if (stem !== ticker) {
      const primary = localListings().find(
        (c) => c.ticker.toUpperCase() === stem,
      );
      if (primary) {
        ticker = stem;
        name = primary.name;
        market = String(primary.market || market);
      }
    }
    if (!ticker || have.has(ticker)) return;
    have.add(ticker);
    cands.push({
      ticker,
      name,
      market,
      source,
      rank: rankListingQuery(q, ticker, name),
    });
  };
  for (const c of localListings()) {
    const ticker = String(c.ticker || "").toUpperCase();
    const name = String(c.name || ticker).trim();
    if (!ticker) continue;
    if (!listingQueryMatches(q, ticker, name)) continue;
    push(
      {
        ticker,
        name,
        market: String(c.market || "NSE") || "NSE",
      },
      "local",
    );
  }
  const localBest = [...cands].sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.source === "local" ? 0 : 1) - (b.source === "local" ? 0 : 1),
  )[0];
  if (localBest && localBest.rank <= 1) {
    return {
      query: q,
      ticker: localBest.ticker,
      name: localBest.name,
      market: localBest.market,
      source: localBest.source,
    };
  }
  const growwQs = listingQueryVariants(q).slice(0, 4);
  for (const gq of growwQs) {
    try {
      const remote = await searchGrowwListings(gq, 8);
      for (const r of remote) {
        push(
          {
            ticker: r.ticker,
            name: r.name,
            market: r.market || "NSE",
          },
          r.bse_scrip && /^\d{5,7}$/.test(q) && r.bse_scrip === q
            ? "groww-scrip"
            : "groww",
        );
      }
    } catch {
      /* local still usable */
    }
    cands.sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.source === "local" ? 0 : 1) - (b.source === "local" ? 0 : 1),
    );
    const mid = cands[0];
    if (mid && mid.rank <= 1) break;
  }
  cands.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.source === "local" ? 0 : 1) - (b.source === "local" ? 0 : 1),
  );
  const best = cands[0];
  if (!best || best.rank > 3) return null;
  return {
    query: q,
    ticker: best.ticker,
    name: best.name,
    market: best.market,
    source: best.source,
  };
}
