import { createNseBuybackSession } from "../nse-buybacks";
import { loadAllCompanies } from "../db";
import { fetchDailyBars } from "../ohlc";
import { fetchLivePrices } from "../yfinance";
import {
  announcedEarnTickers,
  fetchNseAnnouncedCorpEvents,
  fetchNseCorpEvents,
  type NseCorpEvent,
} from "../nse-corp-events";
import { runConcurrent, withScrapeWriteLock } from "../scrape-pool";
import {
  baselineCloseBefore,
  computeDriftPct,
  priceBaselineConsistent,
} from "./concall-drift-math";
import { recordStrategyScan } from "./buyback-store";
import { pairEarnConcall } from "./concall-drift-pair";
import {
  concallDriftScanProgress,
  loadConcallDriftRepairCandidates,
  pendingConcallDriftTickers,
  patchConcallDriftPairing,
  recentlyFetchedConcallTickers,
  recentConcallDriftTickers,
  upsertConcallDriftEvents,
  type ConcallDriftRepairCandidate,
} from "./concall-drift-store";
import type { ConcallDriftEvent } from "./concall-drift-types";
import { fyQuarterFromEarnEvent } from "./concall-drift-quarters";

export type ConcallDriftScanResult = {
  tried: number;
  saved: number;
  failed: number;
  remaining: number;
  scanned: number;
  universe: number;
  saved_tickers: string[];
  done: boolean;
  announced?: number;
  remaining_tickers?: string[];
};

type NseJar = Awaited<ReturnType<typeof createNseBuybackSession>>;

const TICKER_SCAN_MS = 35_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const DEFAULT_BATCH = 16;
const MAX_BATCH = 32;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]);
}

export async function scanTickerConcallDrift(
  ticker: string,
  market: string | null | undefined,
  _price: number | null | undefined,
  daysBack = 120,
  sharedJar?: NseJar,
): Promise<ConcallDriftEvent[]> {
  const events = await fetchNseCorpEvents(ticker, market, daysBack, sharedJar);
  const pairs = pairEarnConcall(events);
  if (!pairs.length) return [];

  const [bars, quotes] = await Promise.all([
    fetchDailyBars(ticker, market, 1),
    fetchLivePrices([{ ticker, market }]),
  ]);
  const price = quotes[0]?.price ?? null;
  const out: ConcallDriftEvent[] = [];

  for (const { earn, concall } of pairs) {
    const baseline = baselineCloseBefore(bars, earn.announced_at);
    const consistent =
      baseline != null && price != null && priceBaselineConsistent(price, baseline);
    const drift = consistent ? computeDriftPct(price, baseline) : null;
    const id = earn.seq_id
      ? `${ticker.toUpperCase()}:${earn.seq_id}`
      : `${ticker.toUpperCase()}:${earn.announced_at.slice(0, 19)}`;
    out.push({
      id,
      ticker: ticker.toUpperCase(),
      earn_at: earn.announced_at,
      concall_at: concall?.announced_at ?? null,
      quarter_fy: fyQuarterFromEarnEvent(earn.announced_at, earn.subject),
      earn_subject: earn.subject,
      concall_subject: concall?.subject ?? null,
      baseline_close: consistent ? baseline : null,
      drift_pct: drift,
      has_baseline: consistent,
      source: "nse_announcements",
    });
  }
  return out;
}

/** Re-pair concall times from NSE for rows missing concall_at (no price re-fetch). */
export async function repairConcallDriftPairing(opts?: {
  tickers?: string[];
  limit?: number;
}): Promise<number> {
  const limit = Math.min(40, Math.max(1, opts?.limit ?? 24));
  const want = new Set((opts?.tickers ?? []).map((t) => t.toUpperCase()));
  const candidates = loadConcallDriftRepairCandidates(limit, want.size ? want : null);
  if (!candidates.length) return 0;

  const jar = await createNseBuybackSession();
  const byTicker = new Map<string, ConcallDriftRepairCandidate[]>();
  for (const c of candidates) {
    const t = c.ticker.toUpperCase();
    const list = byTicker.get(t) ?? [];
    list.push(c);
    byTicker.set(t, list);
  }

  let patched = 0;
  for (const [ticker, rows] of byTicker) {
    const market = rows[0]?.market ?? "NSE";
    const events = await fetchNseCorpEvents(ticker, market, 150, jar);
    const pairs = pairEarnConcall(events);

    for (const row of rows) {
      const earnTs = Date.parse(row.earn_at);
      const seq = row.id.includes(":") ? row.id.slice(row.id.indexOf(":") + 1) : "";
      let concall: NseCorpEvent | null = null;
      for (const p of pairs) {
        if (seq && p.earn.seq_id && p.earn.seq_id === seq) {
          concall = p.concall;
          break;
        }
        const pTs = Date.parse(p.earn.announced_at);
        if (pTs === earnTs || Math.abs(pTs - earnTs) < 36 * 60 * 60 * 1000) {
          concall = p.concall;
          break;
        }
      }
      if (!concall?.announced_at) continue;
      patchConcallDriftPairing(row.id, {
        concall_at: concall.announced_at,
        concall_subject: concall.subject,
        quarter_fy: fyQuarterFromEarnEvent(row.earn_at, row.earn_subject),
      });
      patched += 1;
    }
  }
  return patched;
}

async function ensureWorkerJars(
  concurrency: number,
  cache: Map<number, NseJar>,
): Promise<void> {
  await Promise.all(
    Array.from({ length: concurrency }, async (_, i) => {
      if (cache.has(i)) return;
      cache.set(i, await createNseBuybackSession());
    }),
  );
}

async function scanOneTicker(
  ticker: string,
  companyMap: Map<string, ReturnType<typeof loadAllCompanies>[number]>,
  daysBack: number,
  workerId: number,
  jarCache: Map<number, NseJar>,
): Promise<{ ticker: string; ok: boolean }> {
  const c = companyMap.get(ticker);
  if (!c) {
    await withScrapeWriteLock(() => {
      recordStrategyScan(ticker, "concall_drift", "failed", "unknown ticker");
    });
    return { ticker, ok: false };
  }

  const jar = jarCache.get(workerId)!;

  try {
    const rows = await withTimeout(
      scanTickerConcallDrift(
        c.ticker,
        c.market,
        c.price ?? null,
        daysBack,
        jar,
      ),
      TICKER_SCAN_MS,
      ticker,
    );

    await withScrapeWriteLock(() => {
      if (!rows.length) {
        recordStrategyScan(ticker, "concall_drift", "empty", "no earn events");
        return;
      }
      upsertConcallDriftEvents(rows);
      recordStrategyScan(
        ticker,
        "concall_drift",
        "ok",
        `${rows.length} earn · latest ${rows[0]!.earn_at.slice(0, 10)}`,
      );
    });
    return { ticker, ok: true };
  } catch (err) {
    await withScrapeWriteLock(() => {
      recordStrategyScan(
        ticker,
        "concall_drift",
        "failed",
        err instanceof Error ? err.message : "scan failed",
      );
    });
    return { ticker, ok: false };
  }
}

export async function runConcallDriftScanBatch(opts: {
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
  concurrency?: number;
  daysBack?: number;
  refreshRecent?: boolean;
  announced?: boolean;
  announcedDays?: number;
}): Promise<ConcallDriftScanResult> {
  const limit = Math.min(MAX_BATCH, Math.max(1, opts.limit ?? DEFAULT_BATCH));
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY),
  );
  const missingOnly = opts.missingOnly !== false;
  const daysBack = opts.announced ? Math.min(60, opts.daysBack ?? 60) : (opts.daysBack ?? 120);
  const market = opts.market;
  const announced = opts.announced === true;

  const companyMap = new Map(
    loadAllCompanies().map((c) => [c.ticker.toUpperCase(), c]),
  );

  function passesMarket(ticker: string): boolean {
    if (!market || market === "All") return true;
    const c = companyMap.get(ticker);
    if (!c) return market === "All";
    if (market === "NSE") return c.market === "NSE" || c.market === "NSE SME";
    return c.market === market;
  }

  let jobs: string[];
  let announcedUniverse = 0;
  if (opts.tickers?.length) {
    jobs = opts.tickers.map((t) => t.toUpperCase());
  } else if (announced) {
    const jar = await createNseBuybackSession();
    const events = await fetchNseAnnouncedCorpEvents(opts.announcedDays ?? 7, jar);
    const tickers = announcedEarnTickers(events).filter((t) => {
      if (!companyMap.has(t)) return false;
      return passesMarket(t);
    });
    announcedUniverse = tickers.length;
    const fresh = recentlyFetchedConcallTickers(30 * 60 * 1000);
    jobs = tickers.filter((t) => !fresh.has(t));
  } else if (opts.refreshRecent) {
    jobs = recentConcallDriftTickers({ market });
  } else {
    jobs = pendingConcallDriftTickers({ market, missingOnly });
  }

  const progressBefore = concallDriftScanProgress({ market });
  const universe = announced ? announcedUniverse : progressBefore.universe;
  const scannedBefore = announced
    ? Math.max(0, announcedUniverse - jobs.length)
    : progressBefore.scanned;
  const batch = jobs.slice(0, limit);
  const empty: ConcallDriftScanResult = {
    tried: 0,
    saved: 0,
    failed: 0,
    remaining: jobs.length,
    scanned: scannedBefore,
    universe,
    saved_tickers: [],
    done: jobs.length === 0,
    announced: announced ? announcedUniverse : undefined,
    remaining_tickers: jobs,
  };
  if (!batch.length) return empty;

  const jarCache = new Map<number, NseJar>();
  await ensureWorkerJars(concurrency, jarCache);

  const results = await runConcurrent(batch, concurrency, (ticker, index) =>
    scanOneTicker(
      ticker,
      companyMap,
      daysBack,
      index % concurrency,
      jarCache,
    ),
  );

  const savedTickers: string[] = [];
  let saved = 0;
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      saved += 1;
      savedTickers.push(r.ticker);
    } else {
      failed += 1;
    }
  }

  const remaining = Math.max(0, jobs.length - batch.length);
  const scanned = scannedBefore + batch.length;

  return {
    tried: batch.length,
    saved,
    failed,
    remaining,
    scanned,
    universe,
    saved_tickers: savedTickers,
    done: remaining === 0,
    announced: announced ? announcedUniverse : undefined,
    remaining_tickers: jobs.slice(limit),
  };
}
