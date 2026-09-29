/**
 * PEAD High/Med/Low bands — pure helpers, safe for client components.
 */
import { peadScoreClass } from "./pead-score";

export type ChipBand = "High" | "Med" | "Low";

export type FundamentalsScanRow = {
  sales_yoy: number | null;
  np_yoy: number | null;
  eps_yoy: number | null;
  rev_growth: ChipBand | null;
  margin_exp: ChipBand | null;
  roce_impr: ChipBand | null;
  pead: number | null;
  pead_band: ChipBand | null;
  tech_strength: string | null;
  tech_change: string | null;
  dma200_pct: number | null;
  latest_date: string | null;
};

export function isPeadHhh(row: FundamentalsScanRow | null | undefined): boolean {
  return (
    row?.rev_growth === "High" &&
    row.margin_exp === "High" &&
    row.roce_impr === "High"
  );
}

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

export function bandPead(score: number | null | undefined): ChipBand | null {
  const c = peadScoreClass(score);
  if (c === "pead-good") return "High";
  if (c === "pead-mid") return "Med";
  if (c === "pead-bad") return "Low";
  return null;
}
