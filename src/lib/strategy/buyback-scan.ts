import { loadAllCompanies } from "../db";
import {
  createNseBuybackSession,
  fetchNseBuybackActions,
  fetchNseBuybacksForTicker,
} from "../nse-buybacks";
import {
  buybackEventsNeedScreener,
  fetchScreenerBuybacks,
} from "../screener-buybacks";
import { runConcurrent } from "../scrape-pool";
import {
  pendingBuybackDetailTickers,
  recomputeBuybackSummary,
  recordStrategyScan,
  upsertBuybackEvents,
} from "./buyback-store";

export type BuybackScanResult = {
  tried: number;
  saved: number;
  failed: number;
  remaining: number;
  saved_tickers: string[];
  synced_actions: number;
  screener_enriched: number;
  done: boolean;
};

/** Max Screener company-page fetches per batch (spaced 2.5s — never global search). */
const SCREENER_ENRICH_PER_BATCH = 3;

export async function syncNseBuybackActions(): Promise<number> {
  const jar = await createNseBuybackSession();
  const events = await fetchNseBuybackActions(jar);
  upsertBuybackEvents(events);
  const tickers = new Set(events.map((e) => e.ticker));
  for (const ticker of tickers) {
    recomputeBuybackSummary(ticker);
  }
  return events.length;
}

export async function runBuybackScanBatch(opts: {
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
  concurrency?: number;
  syncActions?: boolean;
}): Promise<BuybackScanResult> {
  const limit = Math.min(24, Math.max(1, opts.limit ?? 8));
  const concurrency = Math.min(3, Math.max(1, opts.concurrency ?? 2));
  const missingOnly = opts.missingOnly !== false;

  let syncedActions = 0;
  if (opts.syncActions !== false) {
    syncedActions = await syncNseBuybackActions();
  }

  let pending: string[];
  if (opts.tickers?.length) {
    pending = opts.tickers.map((t) => t.toUpperCase());
  } else if (missingOnly) {
    pending = pendingBuybackDetailTickers({ market: opts.market });
  } else {
    pending = loadAllCompanies()
      .filter((c) => ["NSE", "NSE SME"].includes(c.market))
      .map((c) => c.ticker.toUpperCase());
    if (opts.market && opts.market !== "All") {
      const companies = loadAllCompanies();
      const allowed = new Set(
        companies
          .filter((c) =>
            opts.market === "NSE"
              ? c.market === "NSE" || c.market === "NSE SME"
              : c.market === opts.market,
          )
          .map((c) => c.ticker.toUpperCase()),
      );
      pending = pending.filter((t) => allowed.has(t));
    }
  }

  const batch = pending.slice(0, limit);

  const empty: BuybackScanResult = {
    tried: 0,
    saved: 0,
    failed: 0,
    remaining: pending.length,
    saved_tickers: [],
    synced_actions: syncedActions,
    screener_enriched: 0,
    done: pending.length === 0,
  };
  if (!batch.length) return empty;

  const jar = await createNseBuybackSession();
  const savedTickers: string[] = [];
  const screenerQueue: Array<{ ticker: string; nseEvents: Awaited<ReturnType<typeof fetchNseBuybacksForTicker>> }> = [];

  const results = await runConcurrent(batch, concurrency, async (ticker) => {
    try {
      const events = await fetchNseBuybacksForTicker(jar, ticker);
      if (buybackEventsNeedScreener(events)) {
        screenerQueue.push({ ticker, nseEvents: events });
      }
      if (events.length) {
        upsertBuybackEvents(events);
        recomputeBuybackSummary(ticker, { detailFetched: true });
        recordStrategyScan(ticker, "buyback", "ok", `${events.length} NSE events`);
        return { ticker, ok: true as const, nse: events.length };
      }
      return { ticker, ok: false as const, nse: 0 };
    } catch (err) {
      recordStrategyScan(
        ticker,
        "buyback",
        "failed",
        err instanceof Error ? err.message : "NSE fetch failed",
      );
      screenerQueue.push({ ticker, nseEvents: [] });
      return { ticker, ok: false as const, nse: 0 };
    }
  });

  let screenerEnriched = 0;
  for (const job of screenerQueue.slice(0, SCREENER_ENRICH_PER_BATCH)) {
    const scEvents = await fetchScreenerBuybacks(job.ticker);
    if (!scEvents.length) {
      if (!job.nseEvents.length) {
        recordStrategyScan(job.ticker, "buyback", "empty", "no NSE or Screener buybacks");
        recomputeBuybackSummary(job.ticker, { detailFetched: true });
      }
      continue;
    }
    upsertBuybackEvents(scEvents);
    recomputeBuybackSummary(job.ticker, { detailFetched: true });
    screenerEnriched += 1;
    if (!savedTickers.includes(job.ticker)) savedTickers.push(job.ticker);
    recordStrategyScan(
      job.ticker,
      "buyback",
      "ok",
      job.nseEvents.length
        ? `${job.nseEvents.length} NSE + ${scEvents.length} Screener`
        : `${scEvents.length} Screener events`,
    );
  }

  let saved = 0;
  let failed = 0;
  for (const r of results) {
    if (!r) {
      failed += 1;
      continue;
    }
    if (r.ok) {
      saved += 1;
      savedTickers.push(r.ticker);
    } else {
      failed += 1;
    }
  }

  const remaining = pendingBuybackDetailTickers({ market: opts.market }).length;

  return {
    tried: batch.length,
    saved,
    failed,
    remaining,
    saved_tickers: savedTickers,
    synced_actions: syncedActions,
    screener_enriched: screenerEnriched,
    done: remaining === 0,
  };
}
