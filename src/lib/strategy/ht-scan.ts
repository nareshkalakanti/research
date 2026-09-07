import { loadAllCompanies } from "../db";
import { filterCompaniesByScanList } from "../scan-lists-server";
import { runConcurrent } from "../scrape-pool";
import { capTier, type CapTier } from "../types";
import { fetchHtIvForTicker } from "./ht-fetch";
import { rankIntrinsicValue, sectorHeadwindTailwind } from "./ht-math";
import {
  clearHtRetryableFailures,
  htCacheStats,
  isHtCacheFresh,
  loadHtIvMap,
  upsertHtIvRows,
} from "./ht-store";
import type { HtSectorRow, HtStockRow } from "./ht-types";

export type HtBoardResult = {
  kind: "ht";
  ranked: HtStockRow[];
  sectors: HtSectorRow[];
  stats: {
    universe: number;
    with_data: number;
    cached_ok: number;
    pending: number;
    failed: number;
  };
  sectors_list: string[];
  sub_sectors: string[];
};

function universeCompanies(market: string, cap: CapTier | "All") {
  const all = loadAllCompanies();
  let list = filterCompaniesByScanList(all, market, all);
  if (cap && cap !== "All") {
    list = list.filter((c) => capTier(c.mcap_cr) === cap);
  }
  return list;
}

export function buildHtBoard(opts: {
  market?: string;
  cap?: CapTier | "All";
  sector?: string | null;
  subSector?: string | null;
  q?: string | null;
  minSectorCompanies?: number;
}): HtBoardResult {
  const market = opts.market || "All";
  const cap = opts.cap || "All";
  const companies = universeCompanies(market, cap);
  const cache = loadHtIvMap();
  const tickers = companies.map((c) => c.ticker.toUpperCase());
  const statsBase = htCacheStats(tickers);

  const byTicker = new Map(
    companies.map((c) => [c.ticker.toUpperCase(), c]),
  );

  let rows: HtStockRow[] = [];
  for (const t of tickers) {
    const cached = cache.get(t);
    if (!cached || cached.status !== "ok" || !isHtCacheFresh(cached)) continue;
    if (
      cached.sales_growth_3y == null ||
      cached.roce_3y == null ||
      cached.pb == null
    ) {
      continue;
    }
    const co = byTicker.get(t);
    rows.push({
      ticker: t,
      market: co?.market || cached.market || "NSE",
      name: co?.name || cached.name || t,
      sector: co?.sector ?? null,
      sub_sector: co?.sub_sector ?? null,
      price: cached.price ?? co?.price ?? null,
      market_cap_cr: cached.market_cap_cr ?? co?.mcap_cr ?? null,
      sales_growth_3y: cached.sales_growth_3y,
      roce_3y: cached.roce_3y,
      pb: cached.pb,
      pe_ratio: cached.pe_ratio,
    });
  }

  const q = (opts.q || "").trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (r) =>
        r.ticker.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.sector || "").toLowerCase().includes(q) ||
        (r.sub_sector || "").toLowerCase().includes(q),
    );
  }
  if (opts.sector && opts.sector !== "All") {
    rows = rows.filter((r) => r.sector === opts.sector);
  }
  if (opts.subSector && opts.subSector !== "All") {
    rows = rows.filter((r) => r.sub_sector === opts.subSector);
  }

  const ranked = rankIntrinsicValue(rows);
  const sectors = sectorHeadwindTailwind(ranked, {
    minCompanies: opts.minSectorCompanies ?? 1,
  });

  const sectorsList = [
    ...new Set(
      companies.map((c) => c.sector?.trim()).filter(Boolean) as string[],
    ),
  ].sort();
  const subSectors = [
    ...new Set(
      companies
        .filter((c) => !opts.sector || opts.sector === "All" || c.sector === opts.sector)
        .map((c) => c.sub_sector?.trim())
        .filter(Boolean) as string[],
    ),
  ].sort();

  return {
    kind: "ht",
    ranked,
    sectors,
    stats: {
      universe: statsBase.universe,
      with_data: ranked.length,
      cached_ok: statsBase.cached_ok,
      pending: statsBase.pending,
      failed: statsBase.failed,
    },
    sectors_list: sectorsList,
    sub_sectors: subSectors,
  };
}

export async function runHtScanBatch(opts: {
  market?: string;
  cap?: CapTier | "All";
  limit?: number;
  concurrency?: number;
  force?: boolean;
  /** Clear rate-limit / incomplete fails once, then refill. */
  retryFailed?: boolean;
}): Promise<{
  tried: number;
  saved: number;
  failed: number;
  remaining: number;
  done: boolean;
  cleared?: number;
  rateLimited?: boolean;
}> {
  const market = opts.market || "All";
  const cap = opts.cap || "All";
  // Faster default than Streamlit's ~0.45s serial throttle: quoteSummary-first
  // + 4 workers. Retry mode stays gentler to recover from Yahoo 429s.
  const retry = opts.retryFailed === true;
  const limit = Math.min(
    40,
    Math.max(1, opts.limit ?? (retry ? 12 : 20)),
  );
  const concurrency = Math.min(
    6,
    Math.max(1, opts.concurrency ?? (retry ? 2 : 4)),
  );
  let cleared = 0;
  if (opts.retryFailed || opts.force) {
    cleared = clearHtRetryableFailures();
  }
  const companies = universeCompanies(market, cap);
  const cache = loadHtIvMap();

  const pending = companies.filter((c) => {
    const row = cache.get(c.ticker.toUpperCase());
    if (opts.force) return true;
    return !row || !isHtCacheFresh(row);
  });

  const batch = pending.slice(0, limit);
  const results = await runConcurrent(batch, concurrency, async (c) => {
    return fetchHtIvForTicker({
      ticker: c.ticker,
      market: c.market,
      name: c.name,
      knownMcapCr: c.mcap_cr,
    });
  });

  upsertHtIvRows(results);
  let saved = 0;
  let failed = 0;
  let rateLimited = false;
  for (const row of results) {
    if (row.status === "ok") saved += 1;
    else {
      failed += 1;
      if (/too many requests|rate.?limit|429/i.test(row.detail || "")) {
        rateLimited = true;
      }
    }
  }

  const remaining = Math.max(0, pending.length - batch.length);
  return {
    tried: batch.length,
    saved,
    failed,
    remaining,
    done: remaining === 0,
    cleared,
    rateLimited,
  };
}
