/**
 * Smart Money Radar — deals enriched with investor tags + SME universe overlap.
 */
import { loadHiddenUniverse } from "@/lib/hidden-portfolio/universe";
import { bareSymbol, symbolsMatch } from "@/lib/bulk-deals/nse";
import { listDeals, type StoredDeal, dealStats } from "@/lib/bulk-deals/store";
import {
  matchInvestors,
  primaryInvestorIds,
  TRACKED_INVESTORS,
  type TrackedInvestor,
} from "./investors";

export type RadarDeal = StoredDeal & {
  investor_ids: string[];
  primary_hit: boolean;
  in_sme_universe: boolean;
  value_cr: number | null;
};

export type InvestorStats = {
  id: string;
  label: string;
  short: string;
  primary: boolean;
  deal_count: number;
  buy_count: number;
  sme_count: number;
  note?: string;
};

export type SmartMoneyRadar = {
  sme_universe_count: number;
  days: number;
  latest_date: string | null;
  total_deals: number;
  smart_deals: number;
  primary_deals: number;
  sme_smart_deals: number;
  investors: InvestorStats[];
  deals: RadarDeal[];
  /** Per-symbol rollup for primary investors in SME universe. */
  sme_hits: Array<{
    symbol: string;
    name: string | null;
    investors: string[];
    last_date: string;
    last_side: string;
    deal_count: number;
  }>;
  /** Recent large BUY deals in SME universe (actionable even without name match). */
  sme_whale_buys: Array<{
    trade_date: string;
    symbol: string;
    security_name: string | null;
    client_name: string;
    quantity: number | null;
    price: number | null;
    value_cr: number | null;
    deal_type: string;
    exchange: string;
  }>;
};

let smeSymbolSet: Set<string> | null = null;

function getSmeSymbols(): Set<string> {
  if (!smeSymbolSet) {
    smeSymbolSet = new Set(
      loadHiddenUniverse({ includeDbSme: true }).map((r) =>
        bareSymbol(r.symbol),
      ),
    );
  }
  return smeSymbolSet;
}

export function invalidateSmeSymbolCache(): void {
  smeSymbolSet = null;
}

function enrichDeal(d: StoredDeal): RadarDeal {
  const investor_ids = matchInvestors(d.client_name);
  const primary_hit = investor_ids.some((id) =>
    primaryInvestorIds().includes(id),
  );
  const sym = bareSymbol(d.symbol);
  const in_sme_universe = getSmeSymbols().has(sym);
  const value_cr =
    d.quantity != null && d.price != null
      ? Math.round(((d.quantity * d.price) / 1e7) * 10) / 10
      : null;
  return {
    ...d,
    investor_ids,
    primary_hit,
    in_sme_universe,
    value_cr,
  };
}

export function buildSmartMoneyRadar(opts?: {
  days?: number;
  investorId?: string;
  smeOnly?: boolean;
  buysOnly?: boolean;
  primaryOnly?: boolean;
  limit?: number;
}): SmartMoneyRadar {
  const days = opts?.days ?? 90;
  const limit = Math.min(opts?.limit ?? 500, 2000);
  const raw = listDeals({ days, limit: limit * 2, smartOnly: false });
  let deals = raw
    .map(enrichDeal)
    .filter((d) => d.investor_ids.length > 0 || d.smart_money);

  if (opts?.primaryOnly) {
    deals = deals.filter((d) => d.primary_hit);
  } else if (!opts?.investorId) {
    // Default view: primary + any smart-money tagged deal
    deals = deals.filter((d) => d.primary_hit || d.smart_money);
  }

  if (opts?.investorId) {
    deals = deals.filter((d) => d.investor_ids.includes(opts.investorId!));
  }
  if (opts?.smeOnly) {
    deals = deals.filter((d) => d.in_sme_universe);
  }
  if (opts?.buysOnly) {
    deals = deals.filter((d) => d.side === "BUY");
  }

  deals = deals.slice(0, limit);

  const stats = dealStats();
  const allForCounts = listDeals({ days, limit: 5000, smartOnly: false });
  const enrichedAll = allForCounts.map(enrichDeal);

  const investorStats: InvestorStats[] = TRACKED_INVESTORS.map(
    (inv: TrackedInvestor) => {
      const invDeals = enrichedAll.filter((d) =>
        d.investor_ids.includes(inv.id),
      );
      return {
        id: inv.id,
        label: inv.label,
        short: inv.short,
        primary: inv.primary,
        note: inv.note,
        deal_count: invDeals.length,
        buy_count: invDeals.filter((d) => d.side === "BUY").length,
        sme_count: invDeals.filter((d) => d.in_sme_universe).length,
      };
    },
  );

  const primary_deals = enrichedAll.filter((d) => d.primary_hit).length;
  const sme_smart = enrichedAll.filter(
    (d) => d.in_sme_universe && d.investor_ids.length > 0,
  );

  const smeMap = new Map<
    string,
    {
      symbol: string;
      name: string | null;
      investors: Set<string>;
      last_date: string;
      last_side: string;
      deal_count: number;
    }
  >();

  for (const d of sme_smart.filter((x) => x.primary_hit)) {
    const sym = bareSymbol(d.symbol);
    let row = smeMap.get(sym);
    if (!row) {
      row = {
        symbol: sym,
        name: d.security_name || null,
        investors: new Set(),
        last_date: d.trade_date,
        last_side: d.side,
        deal_count: 0,
      };
      smeMap.set(sym, row);
    }
    row.deal_count += 1;
    for (const id of d.investor_ids) row.investors.add(id);
    if (d.trade_date >= row.last_date) {
      row.last_date = d.trade_date;
      row.last_side = d.side;
    }
  }

  const latest = stats.latest_date;

  const sme_whale_buys = enrichedAll
    .filter((d) => d.in_sme_universe && d.side === "BUY" && (d.value_cr ?? 0) >= 0.5)
    .sort((a, b) => (b.value_cr ?? 0) - (a.value_cr ?? 0))
    .slice(0, 40)
    .map((d) => ({
      trade_date: d.trade_date,
      symbol: bareSymbol(d.symbol),
      security_name: d.security_name,
      client_name: d.client_name,
      quantity: d.quantity,
      price: d.price,
      value_cr: d.value_cr,
      deal_type: d.deal_type,
      exchange: d.exchange,
    }));

  return {
    sme_universe_count: getSmeSymbols().size,
    days,
    latest_date: latest,
    total_deals: stats.total,
    smart_deals: stats.smart,
    primary_deals,
    sme_smart_deals: sme_smart.filter((d) => d.primary_hit).length,
    investors: investorStats,
    deals,
    sme_hits: [...smeMap.values()]
      .map((r) => ({
        symbol: r.symbol,
        name: r.name,
        investors: [...r.investors],
        last_date: r.last_date,
        last_side: r.last_side,
        deal_count: r.deal_count,
      }))
      .sort((a, b) => b.last_date.localeCompare(a.last_date)),
    sme_whale_buys,
  };
}

export function symbolInSmeUniverse(symbol: string): boolean {
  return getSmeSymbols().has(bareSymbol(symbol));
}

export { symbolsMatch };
