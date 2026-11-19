import { buildStock, loadCtx } from "./nanocap-champs";
import { buildShortlist } from "./shortlist";
import { loadInvestors } from "./smart-entities";
import { loadSmartMap } from "./smart-money";
import { dataStatus, latestReport, loadModelScores, type ModelReport, type ModelScore } from "./sm-model";

export type ModelRow = {
  ticker: string;
  name: string;
  market: string;
  mcap_cr: number | null;
  pe: number | null;
  sector: string | null;
  sub_sector: string | null;
  website: string | null;
  /** 0–100: rank among all scored stocks (100 = model likes it most). */
  score: number;
  prob: number;
  bucket: string;
  why: ModelScore["why"];
  smart: string[];
  trust: number | null;
};

export type ModelPage = {
  report: ModelReport | null;
  data: ReturnType<typeof dataStatus>;
  rows: ModelRow[];
};

export function buildModelPage(): ModelPage {
  const scores = loadModelScores();
  const ctx = loadCtx();
  const smart = loadSmartMap();
  const label = new Map(loadInvestors().map((i) => [i.id, i.label]));
  let short = new Map<string, { trust: number | null }>();
  try {
    short = new Map(buildShortlist().rows.map((r) => [r.ticker, r]));
  } catch {
    /* optional */
  }
  const rows: ModelRow[] = [];
  for (const [t, s] of scores) {
    const st = buildStock(t, ctx);
    rows.push({
      ticker: t,
      name: st.name,
      market: st.market,
      mcap_cr: st.mcap_cr,
      pe: st.pe,
      sector: st.sector ?? null,
      sub_sector: st.sub_sector ?? null,
      website: st.website ?? null,
      score: Math.round(s.pct_rank * 100),
      prob: s.prob,
      bucket: s.bucket,
      why: s.why,
      smart: (smart.get(t) ?? []).filter((h) => h.move !== "exit").map((h) => label.get(h.investor) ?? h.investor),
      trust: short.get(t)?.trust ?? null,
    });
  }
  rows.sort((a, b) => b.prob - a.prob);
  return { report: latestReport(), data: dataStatus(), rows };
}
