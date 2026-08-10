/**
 * Browser-safe Forward PE colour bands (no Node / SQLite imports).
 * Keep thresholds in sync with stocks-ai `fmtFpe` / `PE_CHEAP_MAX`.
 */
export const PE_CHEAP_MAX = 20;

export type ForwardPeBand = "good" | "mid" | "bad" | "none";

export function forwardPeBand(
  pe: number | null | undefined,
): ForwardPeBand {
  if (pe == null || !Number.isFinite(pe)) return "none";
  if (pe >= 500 || pe > 40) return "bad";
  if (pe > PE_CHEAP_MAX) return "mid";
  return "good";
}

export function computeForwardPe(
  price: number | null | undefined,
  latestEps: number | null | undefined,
): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  if (latestEps == null || !Number.isFinite(latestEps)) return null;
  const runRate = latestEps * 4;
  if (runRate <= 0) return 999;
  const pe = price / runRate;
  if (pe > 500) return 999;
  return Math.round(pe * 10) / 10;
}
