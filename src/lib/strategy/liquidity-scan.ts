import { loadAllCompanies } from "../db";
import { runConcurrent } from "../scrape-pool";
import { pendingLiquidityTickers, recordStrategyScan, upsertLiquidityScore } from "./buyback-store";
import { computeLiquidityScore } from "./liquidity-score";

export type LiquidityScanResult = {
  tried: number;
  saved: number;
  failed: number;
  remaining: number;
  saved_tickers: string[];
  done: boolean;
};

export async function runLiquidityScanBatch(opts: {
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
  concurrency?: number;
}): Promise<LiquidityScanResult> {
  const limit = Math.min(20, Math.max(1, opts.limit ?? 10));
  const concurrency = Math.min(4, Math.max(1, opts.concurrency ?? 3));
  const missingOnly = opts.missingOnly !== false;

  let jobs: string[];
  if (opts.tickers?.length) {
    jobs = opts.tickers.map((t) => t.toUpperCase());
  } else {
    jobs = pendingLiquidityTickers({
      market: opts.market,
      missingOnly,
    });
  }

  const batch = jobs.slice(0, limit);
  const empty: LiquidityScanResult = {
    tried: 0,
    saved: 0,
    failed: 0,
    remaining: jobs.length,
    saved_tickers: [],
    done: jobs.length === 0,
  };
  if (!batch.length) return empty;

  const companyMap = new Map(
    loadAllCompanies().map((c) => [c.ticker.toUpperCase(), c]),
  );

  const savedTickers: string[] = [];
  const results = await runConcurrent(batch, concurrency, async (ticker) => {
    const c = companyMap.get(ticker);
    if (!c) {
      recordStrategyScan(ticker, "liquidity", "failed", "unknown ticker");
      return false;
    }
    try {
      const score = await computeLiquidityScore(
        c.ticker,
        c.market,
        c.name,
        c.mcap_cr ?? null,
        c.price ?? null,
      );
      upsertLiquidityScore(score);
      recordStrategyScan(ticker, "liquidity", "ok", score.reason);
      return true;
    } catch (err) {
      recordStrategyScan(
        ticker,
        "liquidity",
        "failed",
        err instanceof Error ? err.message : "compute failed",
      );
      return false;
    }
  });

  let saved = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i += 1) {
    if (results[i]) {
      saved += 1;
      savedTickers.push(batch[i]!);
    } else {
      failed += 1;
    }
  }

  const remaining = pendingLiquidityTickers({
    market: opts.market,
    missingOnly,
  }).length;

  return {
    tried: batch.length,
    saved,
    failed,
    remaining,
    saved_tickers: savedTickers,
    done: remaining === 0,
  };
}
