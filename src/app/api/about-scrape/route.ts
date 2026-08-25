import { NextRequest, NextResponse } from "next/server";
import {
  pageScrapeEmptyMessage,
  pageScrapeSummary,
  pendingScrapeCount,
  runAboutScrapeBatch,
  scrapeAboutForTicker,
  websiteScrapeGapCount,
} from "@/lib/about-scrape";
import {
  SCRAPE_BATCH_DEFAULT,
  SCRAPE_BATCH_MAX,
  SCRAPE_CONCURRENCY_DEFAULT,
} from "@/lib/scrape-pool";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
  /** Page scan: scrape rows missing stored website text (ignore Yahoo gap queue). */
  pageScan?: boolean;
  /** Universe pending: scrape all website gaps (has URL, no stored scrape), not Yahoo-only queue. */
  websiteGap?: boolean;
  /** Re-fetch website even when Yahoo about exists (inline Website tab). */
  rescan?: boolean;
};

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  if (body.tickers?.length === 1) {
    const result = await scrapeAboutForTicker(body.tickers[0]!, {
      despiteYf: true,
      rescan: body.rescan === true,
    });
    return NextResponse.json({
      ok: result.ok,
      ...result,
      tried: 1,
      saved: result.ok ? 1 : 0,
      failed: result.ok ? 0 : result.status === "failed" ? 1 : 0,
      empty:
        !result.ok &&
        (result.status === "empty" || result.status === "blocked")
          ? 1
          : 0,
      remaining: pendingScrapeCount(body.market || "All"),
      saved_tickers: result.ok ? [result.ticker] : [],
      done: false,
      message: result.ok
        ? `Saved website text for ${result.ticker}`
        : result.error || `Scrape ${result.status}`,
    });
  }

  const market = body.market || "All";
  const limit = Math.min(
    SCRAPE_BATCH_MAX,
    Math.max(1, Number(body.limit) || SCRAPE_BATCH_DEFAULT),
  );
  const pageScan = body.pageScan === true && !!body.tickers?.length;
  const websiteGap = body.websiteGap === true && !pageScan;
  const missingOnly = pageScan ? false : body.missingOnly !== false;

  const result = await runAboutScrapeBatch({
    market,
    tickers: body.tickers,
    limit,
    missingOnly,
    despiteYf: pageScan || websiteGap,
    skipStored: !body.rescan,
    concurrency: SCRAPE_CONCURRENCY_DEFAULT,
  });

  const pageStats =
    pageScan && body.tickers ? pageScrapeSummary(body.tickers) : undefined;

  return NextResponse.json({
    ok: true,
    ...result,
    page_stats: pageStats,
    message:
      result.tried === 0
        ? pageScan
          ? pageScrapeEmptyMessage(body.tickers)
          : "Nothing left to scrape for this filter"
        : `Saved ${result.saved} · ${result.failed} failed · ${result.empty} empty · ${result.remaining.toLocaleString()} left`,
  });
}

export async function GET(req: NextRequest) {
  const market = req.nextUrl.searchParams.get("market") || "All";
  const mode = req.nextUrl.searchParams.get("mode") || "yahoo";
  const pending =
    mode === "website"
      ? websiteScrapeGapCount(market)
      : pendingScrapeCount(market);
  return NextResponse.json({
    ok: true,
    pending,
  });
}
