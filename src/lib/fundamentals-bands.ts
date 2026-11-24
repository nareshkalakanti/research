/**
 * High / Med / Low bands for quarterly growth, margin and ROCE change — pure
 * helpers, safe for client components.
 */

export type ChipBand = "High" | "Med" | "Low";

export type FundamentalsScanRow = {
  sales_yoy: number | null;
  np_yoy: number | null;
  eps_yoy: number | null;
  rev_growth: ChipBand | null;
  margin_exp: ChipBand | null;
  roce_impr: ChipBand | null;
  tech_strength: string | null;
  tech_change: string | null;
  dma200_pct: number | null;
  latest_date: string | null;
};

export function bandGrowth(v: number | null | undefined): ChipBand | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 20) return "High";
  if (v >= 8) return "Med";
  return "Low";
}

export function bandMarginBps(bps: number | null | undefined): ChipBand | null {
  if (bps == null || !Number.isFinite(bps)) return null;
  if (bps >= 50) return "High";
  if (bps > 0) return "Med";
  return "Low";
}

export function bandRoceDelta(pp: number | null | undefined): ChipBand | null {
  if (pp == null || !Number.isFinite(pp)) return null;
  if (pp >= 1) return "High";
  if (pp > 0) return "Med";
  return "Low";
}
