/**
 * Listed share price from cached observations only (no live fetch, no DB write).
 * Prefer the freshest positive price among stock_metrics and Screener top-ratios.
 */
import { openSqliteNamed } from "./sqlite-utils";

export type ListedPriceSource = "stock_metrics" | "screener_ratios";

export type ListedPriceObs = {
  price: number;
  fetched_at: string;
  source: ListedPriceSource;
};

/** Pick the newer observation; on equal timestamps prefer stock_metrics. */
export function pickFreshestListedPrice(
  a: ListedPriceObs | null | undefined,
  b: ListedPriceObs | null | undefined,
): ListedPriceObs | null {
  const ok = (x: ListedPriceObs | null | undefined): x is ListedPriceObs =>
    !!x && Number.isFinite(x.price) && x.price > 0 && !!x.fetched_at;
  if (!ok(a)) return ok(b) ? b : null;
  if (!ok(b)) return a;
  if (a.fetched_at > b.fetched_at) return a;
  if (b.fetched_at > a.fetched_at) return b;
  return a.source === "stock_metrics" ? a : b;
}

let mapCache: { at: number; map: Map<string, ListedPriceObs> } | null = null;
const MAP_MS = 5_000;

/** Clear in-memory merge (after metrics / Screener ratio fills). */
export function invalidateListedPriceMap(): void {
  mapCache = null;
}

/**
 * Ticker → freshest cached listed price.
 * Does not mutate stock_metrics or screener_ratios_cache.
 */
export function loadListedPriceMap(): Map<string, ListedPriceObs> {
  const now = Date.now();
  if (mapCache && now - mapCache.at < MAP_MS) return mapCache.map;

  const byTicker = new Map<string, ListedPriceObs>();

  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      for (const r of db
        .prepare(
          `SELECT UPPER(ticker) AS t, price, fetched_at FROM stock_metrics
           WHERE price IS NOT NULL AND price > 0`,
        )
        .all() as Array<{ t: string; price: number; fetched_at: string }>) {
        byTicker.set(r.t, {
          price: r.price,
          fetched_at: r.fetched_at,
          source: "stock_metrics",
        });
      }

      for (const r of db
        .prepare(
          `SELECT UPPER(ticker) AS t, ratios_json, fetched_at FROM screener_ratios_cache`,
        )
        .all() as Array<{ t: string; ratios_json: string; fetched_at: string }>) {
        try {
          const j = JSON.parse(r.ratios_json) as { current_price?: number | null };
          const cp = j.current_price;
          if (cp == null || !Number.isFinite(cp) || cp <= 0) continue;
          const next: ListedPriceObs = {
            price: cp,
            fetched_at: r.fetched_at,
            source: "screener_ratios",
          };
          byTicker.set(r.t, pickFreshestListedPrice(byTicker.get(r.t), next) ?? next);
        } catch {
          /* skip bad json */
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* missing db */
  }

  mapCache = { at: now, map: byTicker };
  return byTicker;
}

export function listedPriceFor(ticker: string): ListedPriceObs | null {
  return loadListedPriceMap().get(ticker.trim().toUpperCase()) ?? null;
}
