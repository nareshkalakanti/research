import { loadAllCompanies } from "./db";
import { listingQueryMatches, rankListingQuery } from "./listing-name-match";

export type VpMapHit = {
  company_id: string;
  company_name: string;
  ticker: string;
  mapping_confidence: number;
};

/**
 * Map a thread title to a listing. Rank 0–1 is high confidence.
 * Rank > 2 is not mapped (no silent guess).
 */
export function mapThreadTitle(title: string): VpMapHit | null {
  const q = title.replace(/\s+/g, " ").trim();
  if (q.length < 3) return null;
  let best: VpMapHit | null = null;
  let bestRank = 99;
  for (const c of loadAllCompanies()) {
    const ticker = String(c.ticker || "").toUpperCase();
    const name = String(c.name || ticker).trim();
    if (!ticker) continue;
    if (!listingQueryMatches(q, ticker, name)) continue;
    const rank = rankListingQuery(q, ticker, name);
    if (rank > 2) continue;
    if (rank < bestRank) {
      bestRank = rank;
      const mapping_confidence = rank <= 0 ? 1 : rank <= 1 ? 0.85 : 0.65;
      best = {
        company_id: ticker,
        company_name: name,
        ticker,
        mapping_confidence,
      };
    }
  }
  return best;
}
