/**
 * Operating Metrics ticker set from Screener quarters cache (server-only).
 * Pass = Stable OPM + Sales growth (YoY ≥5%, or QoQ >0 for short new listings).
 */
import { openSqliteNamed } from "./sqlite-utils";
import {
  passesOperatingMetricsScreen,
  passesStableOpmScreen,
} from "./opm-math";

export {
  classifyOpmConsistency,
  isStableOpm,
  opmPctFromQuarters,
  opmPctSeries,
  passesOperatingMetricsScreen,
  passesStableOpmScreen,
  salesYoyFromQuarters,
  OPERATING_METRICS_MIN_SALES_YOY,
  type OpmConsistency,
  type OperatingMetricsPass,
  type StableOpmPass,
} from "./opm-math";

type CacheRow = {
  ticker: string;
  quarters_json: string;
};

type OpCache = {
  at: number;
  operating: Set<string>;
  stable: Set<string>;
  established: Set<string>;
  newListing: Set<string>;
  scored: number;
};

let cache: OpCache | null = null;
const CACHE_MS = 60_000;

function loadFromCache(): OpCache {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;

  const operating = new Set<string>();
  const stable = new Set<string>();
  const established = new Set<string>();
  const newListing = new Set<string>();
  let scored = 0;

  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const rows = db
        .prepare(`SELECT ticker, quarters_json FROM screener_quarters_cache`)
        .all() as CacheRow[];
      for (const row of rows) {
        let quarters: Array<{
          date?: string;
          revenue?: number | null;
          ebit?: number | null;
        }>;
        try {
          quarters = JSON.parse(row.quarters_json) as typeof quarters;
        } catch {
          continue;
        }
        const opm = passesStableOpmScreen(quarters);
        if (opm.usable < 2) continue;
        if (opm.kind != null || opm.usable >= 4 || quarters.length < 4) {
          scored += 1;
        }
        const t = row.ticker.toUpperCase();
        if (opm.pass && opm.kind) {
          stable.add(t);
          if (opm.kind === "established") established.add(t);
          else newListing.add(t);
        }
        const om = passesOperatingMetricsScreen(quarters);
        if (om.pass) operating.add(t);
      }
    } finally {
      db.close();
    }
  } catch {
    /* metrics.db missing */
  }

  cache = { at: now, operating, stable, established, newListing, scored };
  return cache;
}

/** Stable OPM + Sales growth together. */
export function operatingMetricsTickerSet(): Set<string> {
  return loadFromCache().operating;
}

/** @deprecated Prefer operatingMetricsTickerSet — kept for Fill Quarters coverage helpers. */
export function stableOpmTickerSet(): Set<string> {
  return loadFromCache().stable;
}

export function operatingMetricsStats(): {
  operating: number;
  stable: number;
  established: number;
  new_listing: number;
  scored: number;
} {
  const c = loadFromCache();
  return {
    operating: c.operating.size,
    stable: c.stable.size,
    established: c.established.size,
    new_listing: c.newListing.size,
    scored: c.scored,
  };
}

export function stableOpmStats(): {
  stable: number;
  established: number;
  new_listing: number;
  scored: number;
} {
  const c = loadFromCache();
  return {
    stable: c.stable.size,
    established: c.established.size,
    new_listing: c.newListing.size,
    scored: c.scored,
  };
}

export function invalidateStableOpmCache(): void {
  cache = null;
}

export function invalidateOperatingMetricsCache(): void {
  cache = null;
}
