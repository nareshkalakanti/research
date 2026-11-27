import { loadMetricsMap } from "./metrics";

/** Chart thresholds (₹ Cr) matching the classic microcap distribution board. */
export const MICROCAP_THRESHOLDS_CR = [10, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000] as const;

export type MicrocapBoard = "main" | "sme";

export type MicrocapPoint = { mcap_cr: number; companies: number };

export type MicrocapSeries = {
  board: MicrocapBoard;
  label: string;
  points: MicrocapPoint[];
  universe: number;
  at_or_below_max: number;
};

export type MicrocapDistribution = {
  main: MicrocapSeries;
  sme: MicrocapSeries;
  /** Combined (main + SME) for reference. */
  all: MicrocapSeries;
  as_of: string | null;
};

function isSmeMarket(market: string | null | undefined): boolean {
  const m = (market || "").toUpperCase();
  return m.includes("SME") || m.includes("EMERGE");
}

function cumulative(caps: number[], thresholds: readonly number[]): MicrocapPoint[] {
  const sorted = [...caps].sort((a, b) => a - b);
  return thresholds.map((mcap_cr) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! <= mcap_cr) lo = mid + 1;
      else hi = mid;
    }
    return { mcap_cr, companies: lo };
  });
}

function series(board: MicrocapBoard, label: string, caps: number[], thresholds: readonly number[]): MicrocapSeries {
  const points = cumulative(caps, thresholds);
  return {
    board,
    label,
    points,
    universe: caps.length,
    at_or_below_max: points[points.length - 1]?.companies ?? 0,
  };
}

/**
 * Cumulative company counts by market-cap threshold, split into Main board (NSE/BSE)
 * and SME (NSE SME / BSE SME / Emerge).
 */
export function buildMicrocapDistribution(
  thresholds: readonly number[] = MICROCAP_THRESHOLDS_CR,
): MicrocapDistribution {
  const map = loadMetricsMap();
  const main: number[] = [];
  const sme: number[] = [];
  let asOf: string | null = null;
  for (const row of map.values()) {
    const c = row.market_cap_cr;
    if (c == null || !(c > 0) || !Number.isFinite(c)) continue;
    if (isSmeMarket(row.market)) sme.push(c);
    else main.push(c);
    if (!asOf || row.fetched_at > asOf) asOf = row.fetched_at;
  }
  const allCaps = main.concat(sme);
  return {
    main: series("main", "Main board", main, thresholds),
    sme: series("sme", "SME", sme, thresholds),
    all: series("main", "All", allCaps, thresholds),
    as_of: asOf,
  };
}
