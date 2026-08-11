/**
 * Orchestrate Hidden Portfolio scan: fundamentals → news → score → cache → report.
 */
import type { HiddenCandidate, HiddenUniverseRow } from "./config";
import { smartMoneyHitsForSymbol, dealsForSymbol } from "@/lib/bulk-deals/store";
import { fetchFundamentals } from "./fundamentals";
import { scanNewsCatalysts } from "./news_scanner";
import { computeAlphaScore } from "./scorer";
import { applySmartMoneyFlag } from "./smart_money";
import {
  getCachedCandidate,
  invalidateCandidates,
  latestRunMeta,
  listCachedCandidates,
  recordRun,
  upsertCandidate,
} from "./store";
import { writeHiddenPortfolioReport } from "./report";
import { loadHiddenUniverse } from "./universe";

export type ScanProgress = {
  done: number;
  total: number;
  symbol: string;
  status: string;
};

export type HiddenScanResult = {
  universe_count: number;
  filtered_count: number;
  skipped: Array<{ symbol: string; reason: string }>;
  candidates: HiddenCandidate[];
  report_path: string | null;
  run_date: string;
};

function toCandidate(
  fund: Awaited<ReturnType<typeof fetchFundamentals>>,
  news: Awaited<ReturnType<typeof scanNewsCatalysts>>,
): HiddenCandidate {
  const smartNews = applySmartMoneyFlag(news);
  const dealHits = smartMoneyHitsForSymbol(fund.symbol, 90);
  const recentDeals = dealsForSymbol(fund.symbol, 90).slice(0, 5);

  const smartKeywords = [
    ...new Set([
      ...smartNews.smart_money_keywords,
      ...dealHits.keywords,
    ]),
  ];
  const smartFlag = smartNews.smart_money_flag || dealHits.flag;

  const alpha = computeAlphaScore({
    moat_keywords: news.moat_keywords,
    growth_keywords: news.growth_keywords,
    smart_money_flag: smartFlag,
    mcap_cr: fund.mcap_cr,
  });

  return {
    symbol: fund.symbol,
    name: fund.name,
    sector: fund.sector,
    market: fund.market,
    price: fund.price,
    mcap_cr: fund.mcap_cr,
    pe: fund.pe,
    avg_volume: fund.avg_volume,
    revenue_growth: fund.revenue_growth,
    profit_margin: fund.profit_margin,
    alpha_score: alpha,
    moat_keywords: news.moat_keywords,
    growth_keywords: news.growth_keywords,
    smart_money_flag: smartFlag,
    smart_money_keywords: smartKeywords,
    bulk_deals: recentDeals.map((d) => ({
      trade_date: d.trade_date,
      client_name: d.client_name,
      side: d.side,
      quantity: d.quantity,
      price: d.price,
      deal_type: d.deal_type,
      smart_money: d.smart_money,
    })),
    news: news.news,
    top_headline: news.top_headline,
    top_link: news.top_link,
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Scan a list of universe rows (or default universe).
 * Uses 12h cache unless force=true.
 */
export async function runHiddenPortfolioScan(opts?: {
  symbols?: string[];
  limit?: number;
  force?: boolean;
  writeReport?: boolean;
  includeDbSme?: boolean;
  onProgress?: (p: ScanProgress) => void;
}): Promise<HiddenScanResult> {
  const runDate = new Date().toISOString();
  const skipped: Array<{ symbol: string; reason: string }> = [];

  let universe: HiddenUniverseRow[];
  if (opts?.symbols?.length) {
    const all = loadHiddenUniverse({
      includeDbSme: opts.includeDbSme !== false,
    });
    const want = new Set(opts.symbols.map((s) => s.toUpperCase()));
    universe = all.filter((r) => {
      const bare = r.symbol.replace(/-SM\.NS$/i, "").replace(/\.(NS|BO)$/i, "");
      return (
        want.has(r.symbol.toUpperCase()) ||
        want.has(bare) ||
        [...want].some((w) => r.symbol.toUpperCase().includes(w))
      );
    });
    // Allow explicit symbols not in universe CSV/DB
    for (const raw of opts.symbols) {
      const u = raw.toUpperCase();
      if (universe.some((r) => r.symbol === u || r.symbol.includes(u))) {
        continue;
      }
      universe.push({
        symbol: u.includes(".") ? u : `${u}.NS`,
        name: u.replace(/\.(NS|BO)$/i, ""),
        sector: "",
        market: u.includes("-SM") ? "NSE SME" : "NSE",
      });
    }
  } else {
    universe = loadHiddenUniverse({
      includeDbSme: opts?.includeDbSme !== false,
      limit: opts?.limit,
    });
  }

  if (opts?.limit != null && !opts.symbols?.length) {
    universe = universe.slice(0, opts.limit);
  }

  const force =
    opts?.force === true || (opts?.symbols?.length ?? 0) > 0;
  if (force && universe.length) {
    invalidateCandidates(universe.map((r) => r.symbol));
  }

  const candidates: HiddenCandidate[] = [];
  let filtered = 0;

  for (let i = 0; i < universe.length; i++) {
    const row = universe[i]!;
    opts?.onProgress?.({
      done: i,
      total: universe.length,
      symbol: row.symbol,
      status: "start",
    });

    try {
      if (!force) {
        const cached = getCachedCandidate(row.symbol);
        if (cached) {
          candidates.push(cached);
          if (cached.alpha_score >= 10 && !cached.error) filtered += 1;
          opts?.onProgress?.({
            done: i + 1,
            total: universe.length,
            symbol: row.symbol,
            status: "cache",
          });
          continue;
        }
      }

      // Explicit symbol lists bypass mcap/volume gate so quick scans always score.
      opts?.onProgress?.({
        done: i,
        total: universe.length,
        symbol: row.symbol,
        status: "fundamentals",
      });
      const fund = await fetchFundamentals(row, {
        applyFilter: !opts?.symbols?.length,
      });
      if (!fund.passed) {
        skipped.push({
          symbol: row.symbol,
          reason: fund.skip_reason || "filtered",
        });
        opts?.onProgress?.({
          done: i + 1,
          total: universe.length,
          symbol: row.symbol,
          status: fund.skip_reason || "skip",
        });
        continue;
      }

      filtered += 1;
      opts?.onProgress?.({
        done: i,
        total: universe.length,
        symbol: row.symbol,
        status: "news",
      });
      const news = await scanNewsCatalysts(fund.name, fund.symbol);
      const cand = toCandidate(fund, news);
      upsertCandidate(cand);
      candidates.push(cand);
      opts?.onProgress?.({
        done: i + 1,
        total: universe.length,
        symbol: row.symbol,
        status: `score ${cand.alpha_score}`,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      skipped.push({ symbol: row.symbol, reason });
      console.warn(`[hidden-portfolio] skip ${row.symbol}:`, reason);
      opts?.onProgress?.({
        done: i + 1,
        total: universe.length,
        symbol: row.symbol,
        status: `error ${reason}`,
      });
    }
  }

  candidates.sort((a, b) => b.alpha_score - a.alpha_score);
  recordRun({
    universe_count: universe.length,
    filtered_count: filtered,
    note: opts?.symbols?.join(",") ?? undefined,
  });

  let reportPath: string | null = null;
  if (opts?.writeReport !== false) {
    try {
      reportPath = writeHiddenPortfolioReport({
        runDate,
        universeCount: universe.length,
        filteredCount: filtered,
        candidates,
      });
    } catch (e) {
      console.warn("[hidden-portfolio] report write failed", e);
    }
  }

  return {
    universe_count: universe.length,
    filtered_count: filtered,
    skipped,
    candidates,
    report_path: reportPath,
    run_date: runDate,
  };
}

export function loadHiddenPortfolioView(opts?: {
  minScore?: number;
  limit?: number;
}): {
  candidates: HiddenCandidate[];
  run: ReturnType<typeof latestRunMeta>;
} {
  return {
    candidates: listCachedCandidates(opts),
    run: latestRunMeta(),
  };
}
