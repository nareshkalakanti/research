/**
 * Sync NSE + BSE bulk/block deals into local DB.
 */
import { fetchNseDealsLastDays } from "./nse";
import { fetchBseDealsLastDays } from "./bse";
import { upsertDeals, dealStats, retagSmartMoneyDeals } from "./store";

export type SyncResult = {
  fetched: number;
  inserted: number;
  retagged: number;
  total_in_db: number;
  stats: ReturnType<typeof dealStats>;
  nse_fetched: number;
  bse_fetched: number;
};

export async function syncBulkDeals(opts?: {
  days?: number;
}): Promise<SyncResult> {
  const days = opts?.days ?? 30;
  const [nse, bse] = await Promise.all([
    fetchNseDealsLastDays(days),
    fetchBseDealsLastDays(Math.min(days, 14)),
  ]);
  const rows = [...nse, ...bse];
  const { inserted, total } = upsertDeals(rows);
  const retagged = retagSmartMoneyDeals();
  return {
    fetched: rows.length,
    inserted,
    retagged,
    total_in_db: total,
    stats: dealStats(),
    nse_fetched: nse.length,
    bse_fetched: bse.length,
  };
}
