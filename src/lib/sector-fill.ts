import {
  classifySectorAI,
  classificationCorpus,
  type SectorClassifyInput,
} from "./sector-classify";
import { upsertClassification } from "./classifications-write";
import {
  ensureCompanyAboutRow,
  saveYfAboutProfile,
} from "./company-about-write";
import { loadAllCompanies, hasUsableAboutText } from "./db";
import {
  ensureFundWatchlistInCompanyAbout,
  loadAllFundWatchlistRows,
} from "./fund-watchlists";
import { runConcurrent } from "./scrape-pool";
import { fetchYfAboutProfile } from "./yfinance";

export type SectorFillResult = {
  tried: number;
  saved: number;
  failed: number;
  fetched_about: number;
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

function fundWatchlistNameMap(): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of loadAllFundWatchlistRows()) {
    const ticker = r.ticker.toUpperCase();
    const name = r.name?.trim();
    if (!name || name.toUpperCase() === ticker) continue;
    if (!out.has(ticker)) out.set(ticker, name);
  }
  return out;
}

function resolveDisplayName(
  ticker: string,
  name: string,
  fundNames: Map<string, string>,
): string {
  const key = ticker.toUpperCase();
  if (name.trim().toUpperCase() !== key) return name;
  return fundNames.get(key) ?? name;
}

function hasClassifyCorpus(input: SectorClassifyInput): boolean {
  return hasUsableAboutText(classificationCorpus(input));
}

type ClassifyCompanyRow = {
  ticker: string;
  name: string;
  market: string;
  about: string | null;
  scraped_about: string | null;
};

async function buildClassifyInput(
  c: ClassifyCompanyRow,
  fundNames: Map<string, string>,
): Promise<{ input: SectorClassifyInput; fetchedAbout: boolean }> {
  const name = resolveDisplayName(c.ticker, c.name, fundNames);
  let input: SectorClassifyInput = {
    ticker: c.ticker,
    name,
    market: c.market,
    about: c.about,
    scraped_about: c.scraped_about,
    yf_about: c.about,
  };

  if (hasClassifyCorpus(input)) {
    return { input, fetchedAbout: false };
  }

  ensureCompanyAboutRow(c.ticker, { name, market: c.market });
  const profile = await fetchYfAboutProfile(c.ticker, c.market);
  if (!profile) {
    return { input, fetchedAbout: false };
  }

  saveYfAboutProfile(c.ticker, {
    about: profile.about,
    website: profile.website,
    headquarters: profile.headquarters,
    name,
  });

  input = {
    ...input,
    about: profile.about ?? input.about,
    yf_about: profile.about ?? input.yf_about,
  };
  return { input, fetchedAbout: Boolean(profile.about?.trim()) };
}

export async function fillSectorBatch(opts: {
  market?: string;
  tickers?: string[];
  limit?: number;
  concurrency?: number;
}): Promise<SectorFillResult> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const concurrency = Math.min(4, Math.max(1, opts.concurrency ?? 2));
  const market = opts.market ?? "All";

  ensureFundWatchlistInCompanyAbout();
  const fundNames = fundWatchlistNameMap();

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
    fetched_about: 0,
    remaining: companies.length,
    saved_tickers: [],
    rows: [],
  };
  if (!batch.length) return empty;

  const savedRows: SectorFillResult["rows"] = [];
  const savedTickers: string[] = [];
  let failed = 0;
  let fetchedAbout = 0;

  await runConcurrent(batch, concurrency, async (c) => {
    const { input, fetchedAbout: gotAbout } = await buildClassifyInput(
      c,
      fundNames,
    );
    if (gotAbout) fetchedAbout += 1;

    if (!hasClassifyCorpus(input)) {
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
    fetched_about: fetchedAbout,
    remaining: Math.max(0, companies.length - batch.length),
    saved_tickers: savedTickers,
    rows: savedRows,
  };
}
