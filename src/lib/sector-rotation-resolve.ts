import { loadAllCompanies } from "./db";
import {
  rankListingQuery,
  listingQueryMatches,
  listingQueryVariants,
} from "./listing-name-match";
import { searchGrowwListings } from "./web-mcap";
import type { SectorMember } from "./sector-rotation";

export type ResolvedListing = SectorMember & { query: string; source: string };

export async function resolveListingQuery(
  query: string,
): Promise<ResolvedListing | null> {
  const q = query.trim();
  if (q.length < 2) return null;
  type Cand = SectorMember & { source: string; rank: number };
  const cands: Cand[] = [];
  const have = new Set<string>();
  const push = (row: SectorMember, source: string) => {
    const ticker = row.ticker.toUpperCase();
    if (!ticker || have.has(ticker)) return;
    have.add(ticker);
    cands.push({
      ticker,
      name: row.name,
      market: row.market,
      source,
      rank: rankListingQuery(q, ticker, row.name),
    });
  };
  for (const c of loadAllCompanies()) {
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
          "groww",
        );
      }
    } catch {
      /* local still usable */
    }
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
