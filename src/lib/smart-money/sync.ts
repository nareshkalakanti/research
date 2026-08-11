/**
 * Full smart-money data sync: deals + shareholding scan + news RSS.
 */
import { syncBulkDeals } from "@/lib/bulk-deals/sync";
import { listDeals, dealStats } from "@/lib/bulk-deals/store";
import { bareSymbol } from "@/lib/bulk-deals/nse";
import {
  fetchShareholdingHits,
  priorityShareholdingSymbols,
  scanShareholdingForSymbols,
  type ShareholdingHit,
} from "@/lib/smart-money/shareholding";
import { fetchInvestorNewsSignals } from "@/lib/smart-money/news";
import {
  upsertShareholdingHits,
  upsertNewsSignals,
} from "@/lib/smart-money/signals-store";
import { invalidateSmeSymbolCache } from "@/lib/smart-money/radar";
import { loadShareholdingSeeds } from "@/lib/smart-money/seeds";

export type FullSyncResult = {
  nse_fetched: number;
  bse_fetched: number;
  deals_inserted: number;
  retagged: number;
  shareholding_hits: number;
  shareholding_stored: number;
  news_signals: number;
  news_stored: number;
  stats: ReturnType<typeof dealStats>;
  trilithon_deals: number;
  devabhaktuni_deals: number;
};

export async function syncSmartMoneyData(opts?: {
  days?: number;
  shareholdingMax?: number;
  skipNews?: boolean;
  skipShareholding?: boolean;
}): Promise<FullSyncResult> {
  const days = opts?.days ?? 30;
  const dealSync = await syncBulkDeals({ days });
  invalidateSmeSymbolCache();

  const recentSymbols = listDeals({ days, limit: 300 }).map((d) =>
    bareSymbol(d.symbol),
  );
  let shareholdingHits: ShareholdingHit[] = loadShareholdingSeeds();

  if (!opts?.skipShareholding) {
    const symbols = priorityShareholdingSymbols(recentSymbols);
    try {
      const live = await scanShareholdingForSymbols(symbols, {
        max: opts?.shareholdingMax ?? 8,
      });
      shareholdingHits.push(...live);
    } catch (e) {
      console.warn("[shareholding] live scan failed, using seeds only:", e);
    }
    // Direct scan on ATAM (known Trilithon holding)
    try {
      const atam = await fetchShareholdingHits("ATAM");
      shareholdingHits.push(...atam);
    } catch {
      /* NSE may block — seeds cover ATAM */
    }
  }

    const shStored = upsertShareholdingHits(shareholdingHits);

  let newsRows: Awaited<ReturnType<typeof fetchInvestorNewsSignals>> = [];
  if (!opts?.skipNews) {
    try {
      newsRows = await fetchInvestorNewsSignals();
    } catch (e) {
      console.warn("[news] fetch failed:", e);
    }
  }
  const newsStored = upsertNewsSignals(newsRows);

  const allDeals = listDeals({ days: 180, limit: 5000 });
  const trilithon_deals = allDeals.filter((d) =>
    /trilithon|hidden gems scheme/i.test(d.client_name),
  ).length;
  const devabhaktuni_deals = allDeals.filter((d) =>
    /devabhaktuni/i.test(d.client_name),
  ).length;

  return {
    nse_fetched: dealSync.nse_fetched,
    bse_fetched: dealSync.bse_fetched,
    deals_inserted: dealSync.inserted,
    retagged: dealSync.retagged,
    shareholding_hits: shareholdingHits.length,
    shareholding_stored: shStored,
    news_signals: newsRows.length,
    news_stored: newsStored,
    stats: dealSync.stats,
    trilithon_deals,
    devabhaktuni_deals,
  };
}
