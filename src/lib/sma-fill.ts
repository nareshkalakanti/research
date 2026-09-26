/**
 * Fill daily SMA 20/50/200 for PEAD Tech Strength (missing-only).
 */
import { loadAllCompanies } from "./db";
import { filterCompaniesByScanList } from "./scan-lists-server";
import { runConcurrent } from "./scrape-pool";
import {
  fetchAndCacheSmaStack,
  smaStackTickerSet,
} from "./sma-stack-cache";
import { fundamentalsScanTickerSet, loadFundamentalsScanMap } from "./fundamentals-scan";

function pendingCompanies(
  market: string,
  preferTickers: string[],
): Array<{ ticker: string; market: string }> {
  const pead = fundamentalsScanTickerSet();
  const have = smaStackTickerSet();
  let companies = filterCompaniesByScanList(loadAllCompanies(), market);
  const byTicker = new Map(
    companies.map((c) => [c.ticker.toUpperCase(), c] as const),
  );
  const missing = companies.filter((c) => {
    const t = c.ticker.toUpperCase();
    return pead.has(t) && !have.has(t);
  });
  const peadMap = loadFundamentalsScanMap();
  missing.sort((a, b) => {
    const as = peadMap.get(a.ticker.toUpperCase())?.pead ?? -1;
    const bs = peadMap.get(b.ticker.toUpperCase())?.pead ?? -1;
    return bs - as;
  });
  const prefer: typeof missing = [];
  const seen = new Set<string>();
  for (const raw of preferTickers) {
    const t = raw.trim().toUpperCase();
    if (!t || seen.has(t) || have.has(t)) continue;
    const row = byTicker.get(t);
    if (!row) continue;
    seen.add(t);
    prefer.push(row);
  }
  const rest = missing.filter((c) => !seen.has(c.ticker.toUpperCase()));
  return [...prefer, ...rest];
}

export async function runSmaFillBatch(opts: {
  market?: string;
  tickers?: string[];
  limit?: number;
  concurrency?: number;
}): Promise<{
  ok: true;
  tried: number;
  saved: number;
  failed: number;
  remaining: number;
}> {
  const market = opts.market || "All";
  const limit = Math.min(40, Math.max(1, opts.limit ?? 8));
  const concurrency = Math.min(4, Math.max(1, opts.concurrency ?? 2));
  const queue = pendingCompanies(market, opts.tickers ?? []);
  const pending = queue.slice(0, limit);

  let saved = 0;
  let failed = 0;
  await runConcurrent(pending, concurrency, async (c) => {
    try {
      const stack = await fetchAndCacheSmaStack(c.ticker, c.market);
      if (stack?.price != null) saved += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  });

  const remaining = pendingCompanies(market, opts.tickers ?? []).length;

  return {
    ok: true,
    tried: pending.length,
    saved,
    failed,
    remaining,
  };
}
