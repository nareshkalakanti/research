import { NextRequest, NextResponse } from "next/server";
import { invalidateCompanyCache, loadAllCompanies } from "@/lib/db";
import {
  fillBseSmeMetricsGaps,
  metricsGapCount,
  seedBseSmeMcapFromCache,
  upsertMetrics,
} from "@/lib/metrics";
import { fetchNseMcapQuotes } from "@/lib/nse-quote-mcap";
import { fetchWebProfiles, webProfileToQuote } from "@/lib/web-mcap";
import { applyWebProfiles } from "@/lib/web-profile-apply";
import { fetchLivePrices, fetchQuotes, type YfQuote } from "@/lib/yfinance";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  tickers?: string[];
  market?: string;
  limit?: number;
  concurrency?: number;
  missingOnly?: boolean;
  preferMcap?: boolean;
  skipTickers?: string[];
  offset?: number;
  /** all = Yahoo→NSE→Tickertape. web = Tickertape/Groww only. */
  source?: "all" | "web";
};

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const market = body.market || "All";
  const source = body.source === "web" ? "web" : "all";
  const limit = Math.min(
    source === "web" ? 80 : 200,
    Math.max(1, Number(body.limit) || (source === "web" ? 40 : 80)),
  );
  const missingOnly = body.missingOnly !== false;
  const preferMcap = body.preferMcap !== false;
  const concurrency = Math.min(
    source === "web" ? 8 : 16,
    Math.max(source === "web" ? 2 : 4, Number(body.concurrency) || (source === "web" ? 4 : 12)),
  );

  let companies = loadAllCompanies();
  if (market && market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }

  const tickerSet = body.tickers?.length
    ? new Set(body.tickers.map((t) => t.toUpperCase()))
    : null;
  if (tickerSet) {
    companies = companies.filter((c) => tickerSet.has(c.ticker.toUpperCase()));
  }

  const skip = new Set(
    (body.skipTickers ?? []).map((t) => t.toUpperCase()).filter(Boolean),
  );

  let pending = companies.filter((c) => {
    if (skip.has(c.ticker.toUpperCase())) return false;
    if (source === "web") return c.mcap_cr == null || c.mcap_cr <= 0;
    if (!missingOnly) return true;
    return c.price == null || c.mcap_cr == null || c.mcap_cr <= 0;
  });

  if (preferMcap && source !== "web") {
    // Don't park forever on names Yahoo already quoted (price in, mcap still null).
    // Those sat at the front of Fill All and the same ~80 NSE SME rows were retried
    // while ~500 others never got a detailed mcap pass.
    pending = [
      ...pending.filter((c) => (c.mcap_cr == null || c.mcap_cr <= 0) && c.price == null),
      ...pending.filter((c) => (c.mcap_cr == null || c.mcap_cr <= 0) && c.price != null),
      ...pending.filter((c) => c.mcap_cr != null && c.price == null),
    ];
    const seen = new Set<string>();
    pending = pending.filter((c) => {
      const t = c.ticker.toUpperCase();
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
  }

  const gapsBefore = metricsGapCount(companies.map((c) => c.ticker));
  const offset = Math.max(0, Number(body.offset) || 0);
  const batch = pending.slice(offset, offset + limit);

  if (!batch.length) {
    return NextResponse.json({
      ok: true,
      tried: 0,
      saved: 0,
      filledPrice: 0,
      filledMcap: 0,
      failed: 0,
      remaining: gapsBefore.any,
      remainingMcap: companies.filter((c) => c.mcap_cr == null || c.mcap_cr <= 0).length,
      gaps: gapsBefore,
      message: "Nothing missing to fill",
    });
  }

  const marketBy: Record<string, string> = {};
  for (const c of batch) marketBy[c.ticker.toUpperCase()] = c.market;

  if (source === "web") {
    const profiles = await fetchWebProfiles(batch, {
      concurrency,
      delayMs: 120,
    });
    const applied = applyWebProfiles(profiles, marketBy);
    const webQuotes = profiles
      .map(webProfileToQuote)
      .filter((q): q is YfQuote => q != null);

    const byQuote = new Map(webQuotes.map((q) => [q.ticker.toUpperCase(), q]));
    const quotes = batch.map(
      (c) =>
        byQuote.get(c.ticker.toUpperCase()) ?? {
          ticker: c.ticker.toUpperCase(),
          yf_symbol: "",
          price: null,
          mcap_cr: null,
          sector: null,
          error: "no quote",
        },
    );

    const afterCompanies = loadAllCompanies().filter((c) =>
      market && market !== "All" ? c.market === market : true,
    );
    const afterScope = tickerSet
      ? afterCompanies.filter((c) => tickerSet.has(c.ticker.toUpperCase()))
      : afterCompanies;
    const gapsAfter = metricsGapCount(afterScope.map((c) => c.ticker));

    let filledPrice = 0;
    let filledMcap = 0;
    let failed = 0;
    for (const q of quotes) {
      if (q.price != null) filledPrice += 1;
      if (q.mcap_cr != null) filledMcap += 1;
      if (q.mcap_cr == null) failed += 1;
    }

    return NextResponse.json({
      ok: true,
      source: "web",
      tried: batch.length,
      saved: applied.metrics,
      filledPrice,
      filledMcap,
      webFilled: filledMcap,
      nseFilled: 0,
      profile: applied,
      failed,
      remaining: gapsAfter.any,
      remainingMcap: afterScope.filter((c) => c.mcap_cr == null || c.mcap_cr <= 0)
        .length,
      triedTickers: batch.map((c) => c.ticker),
      closedTickers: batch.map((c) => c.ticker.toUpperCase()),
      gaps: gapsAfter,
      sample: quotes.slice(0, 8).map((q) => ({
        ticker: q.ticker,
        price: q.price,
        mcap_cr: q.mcap_cr,
        yf_symbol: q.yf_symbol,
        error: q.error ?? null,
      })),
    });
  }

  let quotes = tickerSet
    ? await fillPageQuotes(batch, concurrency)
    : await fetchQuotes(
        batch.map((c) => ({ ticker: c.ticker, market: c.market })),
        { concurrency },
      );

  let saved = upsertMetrics(quotes, marketBy);

  if (batch.some((c) => c.market === "BSE SME")) {
    seedBseSmeMcapFromCache(batch.map((c) => c.ticker));
    const bse = await fillBseSmeMetricsGaps(batch, { concurrency: 8 });
    saved += bse.saved;
  }

  const byQuote = new Map(quotes.map((q) => [q.ticker.toUpperCase(), q]));
  const stillNeedMcap = batch.filter((c) => {
    const q = byQuote.get(c.ticker.toUpperCase());
    const mcap = q?.mcap_cr;
    return mcap == null || mcap <= 0;
  });
  let nseFilled = 0;
  const nseTried = new Set(
    stillNeedMcap.map((c) => c.ticker.toUpperCase()),
  );
  if (stillNeedMcap.length) {
    const nseQuotes = await fetchNseMcapQuotes(stillNeedMcap, {
      concurrency: 3,
    });
    nseFilled = nseQuotes.length;
    if (nseQuotes.length) {
      saved += upsertMetrics(nseQuotes, marketBy);
      for (const q of nseQuotes) {
        const key = q.ticker.toUpperCase();
        const prev = byQuote.get(key);
        byQuote.set(key, {
          ticker: key,
          yf_symbol: q.yf_symbol || prev?.yf_symbol || "",
          price: prev?.price ?? q.price ?? null,
          mcap_cr: q.mcap_cr ?? prev?.mcap_cr ?? null,
          sector: prev?.sector ?? q.sector ?? null,
        });
      }
    }
  }

  const stillNeedWeb = batch.filter((c) => {
    const q = byQuote.get(c.ticker.toUpperCase());
    const mcap = q?.mcap_cr;
    return mcap == null || mcap <= 0;
  });
  let webFilled = 0;
  const webTried = new Set(
    stillNeedWeb.map((c) => c.ticker.toUpperCase()),
  );
  if (stillNeedWeb.length) {
    const profiles = await fetchWebProfiles(stillNeedWeb, {
      concurrency: 4,
      delayMs: 120,
    });
    const applied = applyWebProfiles(profiles, marketBy);
    const webQuotes = profiles
      .map(webProfileToQuote)
      .filter((q): q is YfQuote => q != null);
    webFilled = webQuotes.length;
    saved += applied.metrics;
    for (const q of webQuotes) {
      const key = q.ticker.toUpperCase();
      const prev = byQuote.get(key);
      byQuote.set(key, {
        ticker: key,
        yf_symbol: q.yf_symbol || prev?.yf_symbol || "",
        price: prev?.price ?? q.price ?? null,
        mcap_cr: q.mcap_cr ?? prev?.mcap_cr ?? null,
        sector: prev?.sector ?? q.sector ?? null,
      });
    }
  }

  quotes = batch.map(
    (c) =>
      byQuote.get(c.ticker.toUpperCase()) ?? {
        ticker: c.ticker.toUpperCase(),
        yf_symbol: "",
        price: null,
        mcap_cr: null,
        sector: null,
        error: "no quote",
      },
  );

  invalidateCompanyCache();

  const afterCompanies = loadAllCompanies().filter((c) =>
    market && market !== "All" ? c.market === market : true,
  );
  const afterScope = tickerSet
    ? afterCompanies.filter((c) => tickerSet.has(c.ticker.toUpperCase()))
    : afterCompanies;
  const gapsAfter = metricsGapCount(afterScope.map((c) => c.ticker));

  let filledPrice = 0;
  let filledMcap = 0;
  let failed = 0;
  const closedTickers: string[] = [];
  for (const q of quotes) {
    const key = q.ticker.toUpperCase();
    if (q.price != null) filledPrice += 1;
    if (q.mcap_cr != null) filledMcap += 1;
    if (q.price == null && q.mcap_cr == null) failed += 1;
    // Skip later Fill-all rounds once mcap landed, the name is dead, or
    // Yahoo+NSE+Tickertape/Groww already ran for this ticker.
    if (
      q.mcap_cr != null ||
      (q.price == null && q.mcap_cr == null) ||
      webTried.has(key) ||
      nseTried.has(key)
    ) {
      closedTickers.push(key);
    }
  }

  return NextResponse.json({
    ok: true,
    tried: batch.length,
    saved,
    filledPrice,
    filledMcap,
    nseFilled,
    webFilled,
    failed,
    remaining: gapsAfter.any,
    remainingMcap: afterScope.filter((c) => c.mcap_cr == null || c.mcap_cr <= 0).length,
    triedTickers: batch.map((c) => c.ticker),
    closedTickers,
    gaps: gapsAfter,
    sample: quotes.slice(0, 8).map((q) => ({
      ticker: q.ticker,
      price: q.price,
      mcap_cr: q.mcap_cr,
      yf_symbol: q.yf_symbol,
      error: q.error ?? null,
    })),
  });
}

export async function GET(req: NextRequest) {
  const market = req.nextUrl.searchParams.get("market") || "All";
  let companies = loadAllCompanies();
  if (market && market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }
  const gaps = metricsGapCount(companies.map((c) => c.ticker));
  return NextResponse.json({
    market,
    total: companies.length,
    gaps,
    remainingMcap: companies.filter((c) => c.mcap_cr == null || c.mcap_cr <= 0).length,
  });
}

/** Page fill: live quotes first, then a parallel detailed pass for every missing mcap. */
async function fillPageQuotes(
  batch: Array<{ ticker: string; market: string }>,
  concurrency: number,
): Promise<YfQuote[]> {
  const items = batch.map((c) => ({ ticker: c.ticker, market: c.market }));
  const live = await fetchLivePrices(items, { concurrency });
  const by = new Map(live.map((q) => [q.ticker.toUpperCase(), q]));
  const need = batch.filter((c) => {
    const mcap = by.get(c.ticker.toUpperCase())?.mcap_cr;
    return mcap == null || mcap <= 0;
  });
  if (need.length) {
    const extra = await fetchQuotes(
      need.map((c) => ({ ticker: c.ticker, market: c.market })),
      { concurrency },
    );
    for (const q of extra) {
      const key = q.ticker.toUpperCase();
      const prev = by.get(key);
      by.set(key, {
        ticker: key,
        yf_symbol: q.yf_symbol || prev?.yf_symbol || "",
        price: q.price ?? prev?.price ?? null,
        mcap_cr: q.mcap_cr ?? prev?.mcap_cr ?? null,
        sector: q.sector ?? prev?.sector ?? null,
        error: q.mcap_cr != null || q.price != null ? undefined : q.error,
      });
    }
  }
  return batch.map(
    (c) =>
      by.get(c.ticker.toUpperCase()) ?? {
        ticker: c.ticker.toUpperCase(),
        yf_symbol: "",
        price: null,
        mcap_cr: null,
        sector: null,
        error: "no quote",
      },
  );
}
