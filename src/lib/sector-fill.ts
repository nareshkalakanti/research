import {
  classifySectorAI,
  classificationCorpus,
  type SectorClassifyInput,
} from "./sector-classify";
import { upsertClassification } from "./classifications-write";
import { loadAllCompanies } from "./db";
import { runConcurrent } from "./scrape-pool";

export type SectorFillResult = {
  tried: number;
  saved: number;
  failed: number;
  remaining: number;
  saved_tickers: string[];
  rows: Array<{
    ticker: string;
    sector: string;
    sub_sector: string;
    source: string;
    confidence: string;
  }>;
};

export async function fillSectorBatch(opts: {
  market?: string;
  tickers?: string[];
  limit?: number;
  concurrency?: number;
}): Promise<SectorFillResult> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const concurrency = Math.min(4, Math.max(1, opts.concurrency ?? 2));
  const market = opts.market ?? "All";

  let companies = loadAllCompanies().filter(
    (c) => !c.sector?.trim() || !c.sub_sector?.trim(),
  );

  if (market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }
  if (opts.tickers?.length) {
    const set = new Set(opts.tickers.map((t) => t.toUpperCase()));
    companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
  }

  const batch = companies.slice(0, limit);
  const empty: SectorFillResult = {
    tried: 0,
    saved: 0,
    failed: 0,
    remaining: companies.length,
    saved_tickers: [],
    rows: [],
  };
  if (!batch.length) return empty;

  const savedRows: SectorFillResult["rows"] = [];
  const savedTickers: string[] = [];
  let failed = 0;

  await runConcurrent(batch, concurrency, async (c) => {
    const input: SectorClassifyInput = {
      ticker: c.ticker,
      name: c.name,
      market: c.market,
      about: c.about,
      scraped_about: c.scraped_about,
    };
    if (!classificationCorpus(input).trim()) {
      failed += 1;
      return;
    }
    const result = await classifySectorAI(input);
    if (!result) {
      failed += 1;
      return;
    }
    upsertClassification(c.ticker, c.market, {
      sector: result.sector,
      sub_sector: result.sub_sector,
    });
    savedTickers.push(c.ticker);
    savedRows.push({
      ticker: c.ticker,
      sector: result.sector,
      sub_sector: result.sub_sector,
      source: result.source,
      confidence: result.confidence,
    });
  });

  return {
    tried: batch.length,
    saved: savedTickers.length,
    failed,
    remaining: Math.max(0, companies.length - batch.length),
    saved_tickers: savedTickers,
    rows: savedRows,
  };
}
