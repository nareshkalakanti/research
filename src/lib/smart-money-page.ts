import { zaubaUrl } from "./momentum";
import { buildStock, loadCtx } from "./nanocap-champs";
import { buildShortlist } from "./shortlist";
import { loadInvestors } from "./smart-entities";
import {
  loadSmartMap,
  smartScore,
  smartStatus,
  type SmartHolding,
  type SmartStatus,
} from "./smart-money";

export type SmartRow = {
  ticker: string;
  name: string;
  market: string;
  mcap_cr: number | null;
  pe: number | null;
  sector: string | null;
  sub_sector: string | null;
  website: string | null;
  holders: SmartHolding[];
  smart: number;
  /** Shortlist scores when the stock passes the screen (null = not in it). */
  trust: number | null;
  shortlist_score: number | null;
  shortlist_growth: number | null;
  zauba_url: string | null;
};

export type SmartPage = {
  rows: SmartRow[];
  investors: Array<{ id: string; label: string; note?: string }>;
  status: SmartStatus;
};

export function buildSmartPage(): SmartPage {
  const map = loadSmartMap();
  const investors = loadInvestors();
  const order = new Map(investors.map((i, n) => [i.id, n]));
  const ctx = loadCtx();
  let short = new Map<string, { trust: number | null; score: number; score_growth: number }>();
  try {
    short = new Map(buildShortlist().rows.map((r) => [r.ticker, r]));
  } catch {
    /* shortlist optional */
  }
  const rows: SmartRow[] = [];
  for (const [t, holders] of map) {
    const s = buildStock(t, ctx);
    const sl = short.get(t);
    rows.push({
      ticker: t,
      name: s.name,
      market: s.market,
      mcap_cr: s.mcap_cr,
      pe: s.pe,
      sector: s.sector ?? null,
      sub_sector: s.sub_sector ?? null,
      website: s.website ?? null,
      holders: holders.sort(
        (a, b) =>
          (order.get(a.investor) ?? 99) - (order.get(b.investor) ?? 99),
      ),
      smart: smartScore(holders),
      trust: sl?.trust ?? null,
      shortlist_score: sl?.score ?? null,
      shortlist_growth: sl?.score_growth ?? null,
      zauba_url: sl ? null : zaubaUrl(s.name, null),
    });
  }
  rows.sort((a, b) => b.smart - a.smart || (b.mcap_cr ?? 0) - (a.mcap_cr ?? 0));
  return {
    rows,
    investors: investors.map(({ id, label, note }) => ({ id, label, note: note ?? undefined })),
    status: smartStatus(map),
  };
}
