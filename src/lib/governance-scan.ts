/**
 * Governance board scan — NSE DIN upsert into local governance.db.
 * Never clears the database; reports newly seen DINs / directors.
 */
import { loadAllCompanies } from "./db";
import { invalidateGovernanceMapCache } from "./governance-map";
import {
  createNseSession,
  fetchBoardFromNse,
} from "./nse-governance";
import {
  diffIdentities,
  dinBoardTickerSet,
  recordScanAttempt,
  saveCompanyBoard,
  snapshotIdentities,
  type NewIdentity,
} from "./governance-write";

const NSE_MARKETS = new Set(["NSE", "NSE SME"]);

export type GovScanJob = {
  ticker: string;
  name: string;
  market: string;
};

export type GovScanBatchResult = {
  tried: number;
  saved: number;
  skipped_empty: number;
  skipped_protected: number;
  failed: number;
  remaining: number;
  saved_tickers: string[];
  new_dins: string[];
  new_directors: NewIdentity[];
  new_seats: number;
  seat_events: number;
  done: boolean;
  source: string;
};

function isNseMarket(market: string | null | undefined): boolean {
  return NSE_MARKETS.has((market || "").toUpperCase());
}

export function pendingGovernanceJobs(opts: {
  market?: string;
  tickers?: string[];
  /** Skip tickers that already have a DIN board (default true). */
  missingOnly?: boolean;
}): GovScanJob[] {
  const missingOnly = opts.missingOnly !== false;
  let companies = loadAllCompanies().filter((c) => isNseMarket(c.market));

  if (opts.market && opts.market !== "All") {
    companies = companies.filter((c) => c.market === opts.market);
  }
  if (opts.tickers?.length) {
    const set = new Set(opts.tickers.map((t) => t.toUpperCase()));
    companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
  }

  const dinDone = missingOnly ? dinBoardTickerSet() : new Set<string>();

  const jobs: GovScanJob[] = [];
  for (const c of companies) {
    const ticker = c.ticker.toUpperCase();
    const market = c.market.toUpperCase() === "NSE SME" ? "NSE SME" : "NSE";
    // Pending = still missing a DIN board (retries empty/failed attempts).
    if (missingOnly && dinDone.has(ticker)) continue;
    jobs.push({
      ticker,
      name: c.name || ticker,
      market,
    });
  }

  jobs.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return jobs;
}

export async function runGovernanceScanBatch(opts: {
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
  concurrency?: number;
}): Promise<GovScanBatchResult> {
  const limit = Math.min(40, Math.max(1, opts.limit ?? 12));
  const concurrency = Math.min(3, Math.max(1, opts.concurrency ?? 2));
  const missingOnly = opts.missingOnly !== false;

  const pending = pendingGovernanceJobs({
    market: opts.market,
    tickers: opts.tickers,
    missingOnly,
  });
  const batch = pending.slice(0, limit);

  const empty: GovScanBatchResult = {
    tried: 0,
    saved: 0,
    skipped_empty: 0,
    skipped_protected: 0,
    failed: 0,
    remaining: pending.length,
    saved_tickers: [],
    new_dins: [],
    new_directors: [],
    new_seats: 0,
    seat_events: 0,
    done: pending.length === 0,
    source: "nse_governance",
  };

  if (!batch.length) return empty;

  const before = snapshotIdentities();
  const jar = await createNseSession();

  let saved = 0;
  let skippedEmpty = 0;
  let skippedProtected = 0;
  let failed = 0;
  let seatEvents = 0;
  const savedTickers: string[] = [];

  // Process in small waves to respect NSE rate limits.
  for (let i = 0; i < batch.length; i += concurrency) {
    const wave = batch.slice(i, i + concurrency);
    await Promise.all(
      wave.map(async (job) => {
        try {
          const payload = await fetchBoardFromNse(
            job.ticker,
            job.market,
            jar,
          );
          if (!payload?.seats?.length) {
            skippedEmpty += 1;
            recordScanAttempt(
              job.ticker,
              "empty",
              "No NSE governance board / DIN seats",
            );
            return;
          }
          const hasDin = payload.seats.some((s) => s.din);
          const result = saveCompanyBoard({
            ticker: job.ticker,
            name: payload.name || job.name,
            market: job.market === "NSE SME" ? "NSE SME" : payload.market,
            seats: payload.seats,
            notes: payload.source,
            replaceSeats: true,
            protectDinBoard: !hasDin,
          });
          if (result.skipped) {
            skippedProtected += 1;
            recordScanAttempt(
              job.ticker,
              "protected",
              result.reason || "",
            );
            return;
          }
          saved += 1;
          seatEvents += result.events_recorded ?? 0;
          savedTickers.push(job.ticker);
          recordScanAttempt(job.ticker, "saved", payload.source);
        } catch (err) {
          failed += 1;
          const msg =
            err instanceof Error ? err.message.slice(0, 200) : "failed";
          recordScanAttempt(job.ticker, "failed", msg);
        }
      }),
    );
    if (i + concurrency < batch.length) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const diff = diffIdentities(before);
  invalidateGovernanceMapCache();

  const remaining = Math.max(0, pending.length - batch.length);

  return {
    tried: batch.length,
    saved,
    skipped_empty: skippedEmpty,
    skipped_protected: skippedProtected,
    failed,
    remaining,
    saved_tickers: savedTickers,
    new_dins: diff.newDins,
    new_directors: diff.newDirectors,
    new_seats: diff.newSeats,
    seat_events: seatEvents,
    done: remaining === 0,
    source: "nse_governance",
  };
}

/** Force-refresh existing DIN boards (upsert; never wipe DB). */
export async function runGovernanceRefreshBatch(opts: {
  tickers: string[];
  limit?: number;
  concurrency?: number;
}): Promise<GovScanBatchResult> {
  const limit = Math.min(40, Math.max(1, opts.limit ?? 12));
  const tickers = [
    ...new Set(opts.tickers.map((t) => t.toUpperCase()).filter(Boolean)),
  ].slice(0, limit);

  const companies = loadAllCompanies();
  const byTicker = new Map(
    companies.map((c) => [c.ticker.toUpperCase(), c]),
  );

  const jobs: GovScanJob[] = tickers.map((ticker) => {
    const c = byTicker.get(ticker);
    const market =
      c?.market?.toUpperCase() === "NSE SME" ? "NSE SME" : "NSE";
    return {
      ticker,
      name: c?.name || ticker,
      market,
    };
  });

  if (!jobs.length) {
    return {
      tried: 0,
      saved: 0,
      skipped_empty: 0,
      skipped_protected: 0,
      failed: 0,
      remaining: 0,
      saved_tickers: [],
      new_dins: [],
      new_directors: [],
      new_seats: 0,
      done: true,
      source: "nse_governance",
    };
  }

  // missingOnly=false path via explicit tickers
  return runGovernanceScanBatch({
    tickers: jobs.map((j) => j.ticker),
    limit: jobs.length,
    missingOnly: false,
    concurrency: opts.concurrency,
  });
}
