/**
 * Investor picks disclosed in media but not yet in quarterly shareholding
 * filings (often below 1% name-disclosure threshold).
 */
import { loadAllCompanies } from "@/lib/db";
import investorsJson from "./investors.json";
import type { ResolvedHolding } from "./scrape";

export type DisclosedPick = {
  symbol: string;
  exchange?: string;
  company_name?: string;
  holding_entity?: string;
  change_type?: string;
  holding_percent?: number | null;
  holding_value_cr?: number | null;
  /** e.g. "ET Now interview, Jun 2026" */
  source?: string;
};

type InvestorEntry = { name: string; disclosed_picks?: DisclosedPick[] };

export function disclosedPicksFor(investor: string): DisclosedPick[] {
  const inv = (investorsJson as InvestorEntry[]).find((i) => i.name === investor);
  return inv?.disclosed_picks ?? [];
}

function pickToResolved(investor: string, pick: DisclosedPick): ResolvedHolding {
  const sym = pick.symbol.toUpperCase();
  const co = loadAllCompanies().find((c) => c.ticker.toUpperCase() === sym);
  const entity = pick.holding_entity ?? "Disclosed";
  const sourceNote = pick.source ? ` (${pick.source})` : "";
  return {
    company_name: pick.company_name ?? co?.name ?? sym,
    holder_name: investor,
    price: co?.price ?? null,
    quantity: null,
    holding_percent: pick.holding_percent ?? null,
    change_qtr: null,
    change_type: pick.change_type ?? "disclosed",
    holding_value_cr: pick.holding_value_cr ?? 0,
    holding_entity: `${entity}${sourceNote}`,
    symbol: sym,
    exchange: pick.exchange ?? (co?.market === "BSE" ? "BSE" : "NSE"),
    screener_slug: sym,
    sector: co?.sector ?? null,
    sub_sector: co?.sub_sector ?? null,
    industry: null,
  };
}

export function mergeDisclosedResolved(
  investor: string,
  rows: ResolvedHolding[],
): ResolvedHolding[] {
  const picks = disclosedPicksFor(investor);
  if (!picks.length) return rows;
  const have = new Set(
    rows.map((r) => `${(r.symbol || "").toUpperCase()}|${(r.exchange || "NSE").toUpperCase()}`),
  );
  const out = [...rows];
  for (const p of picks) {
    const row = pickToResolved(investor, p);
    const key = `${row.symbol.toUpperCase()}|${(row.exchange || "NSE").toUpperCase()}`;
    if (have.has(key)) continue;
    out.push(row);
    have.add(key);
  }
  return out;
}

export type DisclosedRawRow = {
  investor: string;
  symbol: string;
  exchange: string;
  company_name: string | null;
  holding_percent: number | null;
  change_qtr: number | null;
  change_type: string | null;
  holding_value_cr: number | null;
  price: number | null;
  sector: string | null;
  sub_sector: string | null;
  industry: string | null;
  holding_entity: string | null;
  fetched_at: string | null;
};

export function mergeDisclosedRaw(
  investor: string,
  rows: DisclosedRawRow[],
  fetchedAt: string | null,
): DisclosedRawRow[] {
  const resolved = mergeDisclosedResolved(
    investor,
    rows.map((r) => ({
      company_name: r.company_name ?? r.symbol,
      holder_name: investor,
      price: r.price,
      quantity: null,
      holding_percent: r.holding_percent,
      change_qtr: r.change_qtr,
      change_type: r.change_type ?? "unchanged",
      holding_value_cr: r.holding_value_cr ?? 0,
      holding_entity: r.holding_entity ?? undefined,
      symbol: r.symbol,
      exchange: r.exchange,
      screener_slug: null,
      sector: r.sector,
      sub_sector: r.sub_sector,
      industry: r.industry,
    })),
  );
  const have = new Set(
    rows.map((r) => `${r.symbol.toUpperCase()}|${(r.exchange || "NSE").toUpperCase()}`),
  );
  const out = [...rows];
  for (const r of resolved) {
    const key = `${r.symbol.toUpperCase()}|${(r.exchange || "NSE").toUpperCase()}`;
    if (have.has(key)) continue;
    out.push({
      investor,
      symbol: r.symbol,
      exchange: r.exchange || "NSE",
      company_name: r.company_name,
      holding_percent: r.holding_percent,
      change_qtr: r.change_qtr,
      change_type: r.change_type,
      holding_value_cr: r.holding_value_cr,
      price: r.price,
      sector: r.sector,
      sub_sector: r.sub_sector,
      industry: r.industry,
      holding_entity: r.holding_entity ?? null,
      fetched_at: fetchedAt,
    });
    have.add(key);
  }
  return out;
}

/** Merge disclosed picks for all curated investors into a raw holdings list. */
export function mergeAllDisclosedRaw(rows: DisclosedRawRow[]): DisclosedRawRow[] {
  const byInvestor = new Map<string, DisclosedRawRow[]>();
  for (const r of rows) {
    const list = byInvestor.get(r.investor) ?? [];
    list.push(r);
    byInvestor.set(r.investor, list);
  }
  for (const inv of investorsJson as InvestorEntry[]) {
    if (!inv.disclosed_picks?.length) continue;
    if (!byInvestor.has(inv.name)) byInvestor.set(inv.name, []);
  }
  const fetchedAt = rows.reduce<string | null>((best, r) => {
    if (!r.fetched_at) return best;
    if (!best || r.fetched_at > best) return r.fetched_at;
    return best;
  }, null);
  const out: DisclosedRawRow[] = [];
  for (const [investor, invRows] of byInvestor) {
    out.push(...mergeDisclosedRaw(investor, invRows, fetchedAt));
  }
  return out.sort(
    (a, b) =>
      (b.holding_value_cr ?? -1) - (a.holding_value_cr ?? -1) ||
      (b.holding_percent ?? -1) - (a.holding_percent ?? -1),
  );
}
