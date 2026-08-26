import { NextRequest, NextResponse } from "next/server";
import {
  distinctSectors,
  invalidateCompanyCache,
  loadAllCompanies,
  marketCounts,
} from "@/lib/db";
import {
  aboutHighlightsForRow,
  combinePatterns,
  matchedKeywords,
  scrapeHighlightsForRow,
  textHasTerm,
  tickerMatchesSearch,
} from "@/lib/pattern";
import { themesByIds, loadThemes } from "@/lib/themes";
import type { MatchedThemeTag } from "@/lib/types";
import { matchThemesForRow, mergeThemePortfolioRows, themeMatchPattern } from "@/lib/theme-match";
import { runThemeScrapeBatch, type ThemeScrapeStats } from "@/lib/theme-scrape";
import {
  invalidateBreakoutCache,
  latestSignalDates,
  loadBreakoutMap,
} from "@/lib/signals";
import {
  holdingsTickerSet,
  invalidateHoldingsCache,
} from "@/lib/holdings";
import { edgeTickerSet, invalidateEdgeCache } from "@/lib/edge";
import {
  fundWatchlistCounts,
  invalidateFundWatchlistCache,
  loadFundWatchlistStubs,
  negenTickerSet,
  niveshaayTickerSet,
} from "@/lib/fund-watchlists";
import { invalidateNotesCache, notesTickerSet } from "@/lib/notes";
import { distressSeedSet } from "@/lib/distress/tickers";
import { researchLinks } from "@/lib/links";
import { loadMetricsMap, refreshPagePrices } from "@/lib/metrics";
import {
  companyGapFlags,
  loadScrapeOutcomeSets,
  matchesMissingGap,
} from "@/lib/missing-data";
import { capTier, type CapTier } from "@/lib/types";
import {
  isScanWatchlist,
} from "@/lib/scan-lists";
import { filterCompaniesByScanList } from "@/lib/scan-lists-server";
import type { BbTimeframe } from "@/lib/signals";

export const runtime = "nodejs";
export const maxDuration = 120;

export type { CapTier };

export async function GET(req: NextRequest) {
  try {
    return await buildCompaniesResponse(req);
  } catch (err) {
    const message =
      err instanceof Error ? err.message.slice(0, 200) : "Companies load failed";
    console.error("[api/companies]", err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

function fundStubRow(stub: {
  ticker: string;
  name: string;
  market: string;
}) {
  const links = researchLinks(stub.ticker, stub.market, null);
  const name = stub.name?.trim() || stub.ticker;
  return {
    ticker: stub.ticker,
    name,
    market: stub.market,
    website: null,
    about: null,
    scraped_about: null,
    scrape_source_url: null,
    headquarters: null,
    sector: null,
    sub_sector: null,
    price: null,
    mcap_cr: null,
    search_text: `${stub.ticker} ${name}`.toLowerCase(),
    web: links.web,
    sc: links.sc,
    tv: links.tv,
  };
}

function appendFundWatchlistStubs(
  companies: ReturnType<typeof loadAllCompanies>,
  tickers: Set<string>,
  all: ReturnType<typeof loadAllCompanies>,
) {
  if (!tickers.size) return companies;
  const byTicker = new Map(all.map((c) => [c.ticker.toUpperCase(), c]));
  const have = new Set(companies.map((c) => c.ticker.toUpperCase()));
  const out = [...companies];
  for (const listKey of ["niveshaay", "negen"] as const) {
    for (const stub of loadFundWatchlistStubs(listKey, have)) {
      if (!tickers.has(stub.ticker.toUpperCase())) continue;
      out.push(byTicker.get(stub.ticker.toUpperCase()) ?? fundStubRow(stub));
      have.add(stub.ticker.toUpperCase());
    }
  }
  return out;
}

function activeFundFilterSet(
  niveshaay: Set<string>,
  negen: Set<string>,
  opts: { niveshaay: boolean; negen: boolean },
): Set<string> | null {
  if (!opts.niveshaay && !opts.negen) return null;
  if (opts.niveshaay && opts.negen) {
    return new Set([...niveshaay].filter((t) => negen.has(t)));
  }
  if (opts.niveshaay) return niveshaay;
  return negen;
}

type CompanyRow = ReturnType<typeof loadAllCompanies>[number];

/** Tag / watchlist chips — run after theme merge so injected rows respect filters. */
function applyWatchlistFilters(
  input: CompanyRow[],
  opts: {
    filterSme: boolean;
    filterHold: boolean;
    filterDistress: boolean;
    filterEdge: boolean;
    filterNiveshaay: boolean;
    filterNegen: boolean;
    filterNote: boolean;
    holdings: Set<string>;
    distressSet: Set<string>;
    edge: Set<string>;
    niveshaay: Set<string>;
    negen: Set<string>;
    notes: Set<string>;
    allCompanies: CompanyRow[];
  },
): CompanyRow[] {
  let companies = input;

  if (opts.filterSme) {
    companies = companies.filter((c) => /\bSME\b/i.test(c.market));
  }

  if (opts.filterHold) {
    companies = companies.filter((c) =>
      opts.holdings.has(c.ticker.toUpperCase()),
    );
  }

  if (opts.filterDistress) {
    companies = companies.filter((c) =>
      opts.distressSet.has(c.ticker.toUpperCase()),
    );
  }

  if (opts.filterEdge) {
    companies = companies.filter((c) => opts.edge.has(c.ticker.toUpperCase()));
  }

  const fundFilter = activeFundFilterSet(opts.niveshaay, opts.negen, {
    niveshaay: opts.filterNiveshaay,
    negen: opts.filterNegen,
  });
  if (fundFilter) {
    companies = companies.filter((c) =>
      fundFilter.has(c.ticker.toUpperCase()),
    );
    companies = appendFundWatchlistStubs(
      companies,
      fundFilter,
      opts.allCompanies,
    );
  }

  if (opts.filterNote) {
    companies = companies.filter((c) =>
      opts.notes.has(c.ticker.toUpperCase()),
    );
  }

  return companies;
}

function mergeFundWatchlistUniverse(
  companies: ReturnType<typeof loadAllCompanies>,
  all: ReturnType<typeof loadAllCompanies>,
  fund: { niveshaay: Set<string>; negen: Set<string> },
) {
  const fundAll = new Set([...fund.niveshaay, ...fund.negen]);
  if (!fundAll.size) return companies;
  const byTicker = new Map(companies.map((c) => [c.ticker.toUpperCase(), c]));
  for (const c of all) {
    const t = c.ticker.toUpperCase();
    if (fundAll.has(t)) byTicker.set(t, c);
  }
  return appendFundWatchlistStubs([...byTicker.values()], fundAll, all);
}

async function buildCompaniesResponse(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.get("refresh") === "1") {
    invalidateCompanyCache();
    invalidateBreakoutCache();
    invalidateHoldingsCache();
    invalidateEdgeCache();
    invalidateFundWatchlistCache();
    invalidateNotesCache();
  }
  const market = sp.get("market") || "All";
  const bbTf: BbTimeframe = sp.get("bbTf") === "monthly" ? "monthly" : "weekly";
  const q = (sp.get("q") || "").trim();
  const mode = (sp.get("mode") || "OR").toUpperCase() === "AND" ? "AND" : "OR";
  const sector = sp.get("sector") || "All";
  const cap = (sp.get("cap") || "All") as CapTier | "All";
  const filterSme = sp.get("sme") === "1";
  const filterBb = sp.get("bb") === "1";
  const filterTq = sp.get("tq") === "1";
  const filterEma = sp.get("ema") === "1";
  const filterAth = sp.get("ath") === "1";
  const filterHigh52 = sp.get("high52") === "1";
  const filterDd = sp.get("dd") === "1";
  const filterMom = sp.get("mom") === "1";
  const bbAnd = sp.get("bbAnd") === "1";
  const filterHold = sp.get("hold") === "1";
  const filterDistress = sp.get("distress") === "1";
  const filterEdge = sp.get("edge") === "1";
  const filterNiveshaay = sp.get("niveshaay") === "1";
  const filterNegen = sp.get("negen") === "1";
  const filterNote = sp.get("note") === "1";
  const fundListMode = filterNiveshaay || filterNegen;
  /** Theme scan: if any matches have BB/TQ, keep only those (OR). */
  const preferBreakouts = sp.get("preferBreakouts") === "1";
  const themeIds = (sp.get("themes") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const custom = (sp.get("custom") || "").trim();
  const selectedThemes = themesByIds(themeIds);
  const themePatterns = selectedThemes.map((t) => themeMatchPattern(t));
  const scanPattern = combinePatterns([...themePatterns, custom]);
  const page = Math.max(1, Number(sp.get("page") || 1));
  const pageSize = Math.min(200, Math.max(10, Number(sp.get("pageSize") || 100)));
  const sort = sp.get("sort") || "sector";
  const dir = sp.get("dir") === "desc" ? "desc" : "asc";
  const scan = sp.get("scan") === "1";
  const dynamicScrape = sp.get("dynamicScrape") === "1";
  const scrapeLimit = Math.min(
    15,
    Math.max(1, Number(sp.get("scrapeLimit") || 5)),
  );
  const missing = (sp.get("missing") || "").trim().toLowerCase();
  const scrapeOutcomes = loadScrapeOutcomeSets(
    market && market !== "All" ? market : "All",
  );

  const breakouts = loadBreakoutMap(bbTf);
  const holdings = holdingsTickerSet();
  const distressSet = distressSeedSet();
  const edge = edgeTickerSet();
  const niveshaay = niveshaayTickerSet();
  const negen = negenTickerSet();
  const fundCounts = fundWatchlistCounts();
  const notes = notesTickerSet();

  let companies = loadAllCompanies();
  const allCompanies = companies;

  function applyMarketPoolFilters(pool: typeof companies): typeof companies {
    let out = pool;
    if (!watchlistMode && !scanListMode && market && market !== "All") {
      if (market === "NSE" && (scan || q.trim())) {
        out = out.filter(
          (c) => c.market === "NSE" || c.market === "NSE SME",
        );
      } else {
        out = out.filter((c) => c.market === market);
      }
    }
    if (scanListMode) {
      out = filterCompaniesByScanList(out, market, allCompanies, fundStubRow);
    }
    if (sector && sector !== "All") {
      out = out.filter((c) => c.sector === sector);
    }
    if (cap && cap !== "All") {
      out = out.filter((c) => capTier(c.mcap_cr) === cap);
    }
    return out;
  }

  // Hold / Edge / Notes are cross-market lists — don't hide SME/BSE when those chips are on.
  const watchlistMode =
    filterHold ||
    filterDistress ||
    filterEdge ||
    filterNiveshaay ||
    filterNegen ||
    filterSme ||
    filterNote;
  const scanListMode = isScanWatchlist(market);
  companies = applyMarketPoolFilters(companies);

  let scrapeStats: ThemeScrapeStats | null = null;
  if (
    scan &&
    dynamicScrape &&
    selectedThemes.length > 0 &&
    !missing
  ) {
    const pool = companies;
    scrapeStats = await runThemeScrapeBatch({
      companies: pool,
      themes: selectedThemes,
      limit: scrapeLimit,
    });
    if (scrapeStats.saved > 0) {
      companies = applyMarketPoolFilters(loadAllCompanies());
    }
  }

  if (missing) {
    companies = mergeFundWatchlistUniverse(companies, allCompanies, {
      niveshaay,
      negen,
    });
  }

  function gapFlags(c: (typeof companies)[number]) {
    return companyGapFlags(c, scrapeOutcomes);
  }

  if (missing) {
    companies = companies.filter((c) =>
      matchesMissingGap(gapFlags(c), missing),
    );
  }

  const qTerms = q
    ? q
        .split("|")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  if (qTerms.length) {
    companies = companies.filter((c) => {
      const hit = (term: string) => {
        const t = term.toLowerCase();
        // Tickers: exact or prefix (TATA → TATAINVEST), not mid-string (atam ↛ DATAMATICS).
        if (tickerMatchesSearch(c.ticker, t)) return true;
        // Names / about / sector: whole-word only (avoid parastatals → tata).
        return textHasTerm(c.search_text, t);
      };
      return mode === "AND" ? qTerms.every(hit) : qTerms.some(hit);
    });
  }

  const matchedByTheme: Record<string, string[]> = {};
  const matchedThemeIdsByTicker: Record<string, string[]> = {};
  const highlightsByTicker: Record<string, string[]> = {};
  const fullHighlightsByTicker: Record<string, string[]> = {};

  if (scan && (selectedThemes.length > 0 || custom.trim())) {
    const hits = [];
    for (const c of companies) {
      const result = matchThemesForRow(c, selectedThemes, {
        customPattern: custom.trim() || null,
      });
      if (!result.matched) continue;
      hits.push(c);
      matchedByTheme[c.ticker] = result.matchedTerms;
      matchedThemeIdsByTicker[c.ticker] = result.matchedThemeIds;
      fullHighlightsByTicker[c.ticker] = result.highlights;
      highlightsByTicker[c.ticker] = aboutHighlightsForRow(
        c.about,
        result.highlights,
      );
    }
    companies = hits;
  } else if (scan && !scanPattern && !fundListMode) {
    companies = [];
  } else if (qTerms.length) {
    const qPattern = qTerms.join(" | ");
    for (const c of companies) {
      const allHits = matchedKeywords(c.search_text, qPattern, c.search_text);
      fullHighlightsByTicker[c.ticker] = allHits;
      highlightsByTicker[c.ticker] = aboutHighlightsForRow(c.about, allHits);
    }
  }

  // Signal counts for current list — NSE counts include NSE SME when listing NSE.
  const signalCounts = (() => {
    let pool = allCompanies;
    if (scanListMode) {
      pool = filterCompaniesByScanList(pool, market, allCompanies, fundStubRow);
    } else if (!watchlistMode && market && market !== "All") {
      if (market === "NSE") {
        pool = pool.filter(
          (c) => c.market === "NSE" || c.market === "NSE SME",
        );
      } else {
        pool = pool.filter((c) => c.market === market);
      }
    }
    if (sector && sector !== "All") {
      pool = pool.filter((c) => c.sector === sector);
    }
    if (cap && cap !== "All") {
      pool = pool.filter((c) => capTier(c.mcap_cr) === cap);
    }
    let bb = 0;
    let tq = 0;
    let ema = 0;
    let ath = 0;
    let high52 = 0;
    let dd = 0;
    let mom = 0;
    let hold = 0;
    let edgeCount = 0;
    let smeCount = 0;
    let note = 0;
    let distressCount = 0;
    const themeScanActive =
      scan && (selectedThemes.length > 0 || custom.trim());
    for (const c of pool) {
      if (themeScanActive) {
        if (
          !matchThemesForRow(c, selectedThemes, {
            customPattern: custom.trim() || null,
          }).matched
        ) {
          continue;
        }
      }
      const t = c.ticker.toUpperCase();
      const flags = breakouts.get(t);
      if (flags?.has_bb) bb += 1;
      if (flags?.has_tq) tq += 1;
      if (flags?.has_ema) ema += 1;
      if (flags?.has_ath) ath += 1;
      if (flags?.has_high52) high52 += 1;
      if (flags?.has_dd) dd += 1;
      if (flags?.has_mom) mom += 1;
      if (holdings.has(t)) hold += 1;
      if (edge.has(t)) edgeCount += 1;
      if (/\bSME\b/i.test(c.market)) smeCount += 1;
      if (notes.has(t)) note += 1;
      if (distressSet.has(t)) distressCount += 1;
    }
    return {
      bb,
      tq,
      ema,
      ath,
      high52,
      dd,
      mom,
      hold,
      edge: edgeCount,
      niveshaay: fundCounts.niveshaay,
      negen: fundCounts.negen,
      sme: smeCount,
      note,
      distress: distressCount,
    };
  })();

  // BB/TQ/EMA/ATH/52W/DD/MOM narrows scan results — skip when viewing a fund watchlist.
  if (
    (filterBb ||
      filterTq ||
      filterEma ||
      filterAth ||
      filterHigh52 ||
      filterDd ||
      filterMom) &&
    !fundListMode
  ) {
    companies = companies.filter((c) => {
      const flags = breakouts.get(c.ticker.toUpperCase());
      const hasBb = !!flags?.has_bb;
      const hasTq = !!flags?.has_tq;
      const hasEma = !!flags?.has_ema;
      const hasAth = !!flags?.has_ath;
      const hasHigh52 = !!flags?.has_high52;
      const hasDd = !!flags?.has_dd;
      const hasMom = !!flags?.has_mom;
      if (filterBb) return hasBb;
      if (filterTq) return hasTq;
      if (filterEma) return hasEma;
      if (filterAth) return hasAth;
      if (filterHigh52) return hasHigh52;
      if (filterDd) return hasDd;
      if (filterMom) return hasMom;
      return false;
    });
  } else if (preferBreakouts && scan) {
    // Theme results: if any hit has a scan signal, show only those.
    const withSignal = companies.filter((c) => {
      const flags = breakouts.get(c.ticker.toUpperCase());
      return (
        !!flags?.has_bb ||
        !!flags?.has_tq ||
        !!flags?.has_ema ||
        !!flags?.has_ath ||
        !!flags?.has_high52 ||
        !!flags?.has_dd ||
        !!flags?.has_mom
      );
    });
    if (withSignal.length > 0) {
      companies = withSignal;
    }
  }

  if (scan && (selectedThemes.length > 0 || custom.trim())) {
    let themePool = allCompanies;
    if (!watchlistMode && market && market !== "All") {
      if (market === "NSE") {
        themePool = themePool.filter(
          (c) => c.market === "NSE" || c.market === "NSE SME",
        );
      } else {
        themePool = themePool.filter((c) => c.market === market);
      }
    }
    companies = mergeThemePortfolioRows(companies, themePool, selectedThemes, {
      customPattern: custom,
      holdings,
      matchedByTheme,
      matchedThemeIdsByTicker,
      highlightsByTicker,
      fullHighlightsByTicker,
    });
  }

  companies = applyWatchlistFilters(companies, {
    filterSme,
    filterHold,
    filterDistress,
    filterEdge,
    filterNiveshaay,
    filterNegen,
    filterNote,
    holdings,
    distressSet,
    edge,
    niveshaay,
    negen,
    notes,
    allCompanies,
  });

  const mul = dir === "desc" ? -1 : 1;
  const themeScanActive =
    scan && (selectedThemes.length > 0 || custom.trim());
  companies = [...companies].sort((a, b) => {
    if (themeScanActive) {
      const ah = holdings.has(a.ticker.toUpperCase()) ? 0 : 1;
      const bh = holdings.has(b.ticker.toUpperCase()) ? 0 : 1;
      if (ah !== bh) return ah - bh;
    }
    if (sort === "momentum_pct") {
      const am =
        breakouts.get(a.ticker.toUpperCase())?.mom?.momentum_pct ?? null;
      const bm =
        breakouts.get(b.ticker.toUpperCase())?.mom?.momentum_pct ?? null;
      const an = am == null ? Number.NEGATIVE_INFINITY : am;
      const bn = bm == null ? Number.NEGATIVE_INFINITY : bm;
      return (an - bn) * mul;
    }
    const sortKey = sort as keyof (typeof companies)[number];
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === "number" || typeof bv === "number") {
      return ((Number(av) || 0) - (Number(bv) || 0)) * mul;
    }
    return String(av ?? "").localeCompare(String(bv ?? "")) * mul;
  });

  const breakoutsPreferred =
    preferBreakouts &&
    scan &&
    !filterBb &&
    !filterTq &&
    !filterEma &&
    !filterAth &&
    !filterHigh52 &&
    !filterDd &&
    !filterMom &&
    companies.length > 0 &&
    companies.every((c) => {
      const flags = breakouts.get(c.ticker.toUpperCase());
      return (
        !!flags?.has_bb ||
        !!flags?.has_tq ||
        !!flags?.has_ema ||
        !!flags?.has_ath ||
        !!flags?.has_high52 ||
        !!flags?.has_dd ||
        !!flags?.has_mom
      );
    });

  const total = companies.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pageSafe = Math.min(page, pages);
  const start = (pageSafe - 1) * pageSize;
  const pageItems = companies.slice(start, start + pageSize);

  const forcePriceRefresh = sp.get("refresh") === "1";
  // Background price/mcap refresh for list tabs (skip Missing data — no live quotes needed).
  if (pageItems.length && !missing) {
    try {
      await refreshPagePrices(
        pageItems.map((c) => ({ ticker: c.ticker, market: c.market })),
        { force: forcePriceRefresh },
      );
    } catch (err) {
      console.warn("[api/companies] price refresh skipped:", err);
    }
  }
  const metricsMap = loadMetricsMap();
  const allThemes = loadThemes().themes;
  const themeById = new Map(allThemes.map((t) => [t.id, t]));
  /** Annotate themes against selected set when scanning; otherwise all themes. */
  const annotateThemes =
    themeScanActive && selectedThemes.length > 0 ? selectedThemes : allThemes;

  const slice = pageItems.map((c) => {
    const m = metricsMap.get(c.ticker.toUpperCase());
    const row = {
      ...c,
      price: m?.price ?? c.price,
      mcap_cr: m?.market_cap_cr ?? c.mcap_cr,
    };

    let themeIds = matchedThemeIdsByTicker[row.ticker] ?? [];
    let fullHits = fullHighlightsByTicker[row.ticker] ?? [];
    let aboutHits = highlightsByTicker[row.ticker] ?? [];

    if (!themeIds.length || (!fullHits.length && annotateThemes.length > 0)) {
      const result = matchThemesForRow(row, annotateThemes, {
        customPattern:
          themeScanActive && custom.trim() ? custom.trim() : null,
      });
      if (result.matchedThemeIds.length) {
        themeIds = result.matchedThemeIds;
        matchedThemeIdsByTicker[row.ticker] = themeIds;
      }
      if (result.highlights.length && !fullHits.length) {
        fullHits = result.highlights;
        fullHighlightsByTicker[row.ticker] = fullHits;
        aboutHits = aboutHighlightsForRow(row.about, fullHits);
        highlightsByTicker[row.ticker] = aboutHits;
        if (!matchedByTheme[row.ticker]?.length) {
          matchedByTheme[row.ticker] = result.matchedTerms;
        }
      }
    }

    const matched_themes: MatchedThemeTag[] = themeIds
      .map((id) => {
        const t = themeById.get(id);
        if (!t) return null;
        return {
          id: t.id,
          tag: t.tag?.trim() || t.name,
          name: t.name,
        };
      })
      .filter((x): x is MatchedThemeTag => !!x);

    const { search_text: _, ...rest } = row;
    const g = gapFlags(row);
    const flags = breakouts.get(row.ticker.toUpperCase());
    return {
      ...rest,
      matched: matchedByTheme[row.ticker] ?? [],
      matched_themes,
      highlights: aboutHits,
      scrape_highlights: scrapeHighlightsForRow(row.scraped_about, fullHits),
      has_bb: !!flags?.has_bb,
      has_tq: !!flags?.has_tq,
      has_ema: !!flags?.has_ema,
      has_ath: !!flags?.has_ath,
      has_high52: !!flags?.has_high52,
      has_dd: !!flags?.has_dd,
      has_mom: !!flags?.has_mom,
      momentum_pct: flags?.mom?.momentum_pct ?? null,
      has_hold: holdings.has(row.ticker.toUpperCase()),
      has_distress: distressSet.has(row.ticker.toUpperCase()),
      has_edge: edge.has(row.ticker.toUpperCase()),
      has_niveshaay: niveshaay.has(row.ticker.toUpperCase()),
      has_negen: negen.has(row.ticker.toUpperCase()),
      has_note: notes.has(row.ticker.toUpperCase()),
      bb: flags?.bb,
      tq: flags?.tq,
      ema: flags?.ema,
      ath: flags?.ath,
      high52: flags?.high52,
      dd: flags?.dd,
      mom: flags?.mom,
      missing: {
        price: g.price,
        mcap: g.mcap,
        sector: g.sector,
        sub_sector: g.sub_sector,
        about: g.about,
        web: g.web,
        scrape: g.scrape,
        scrape_empty: g.scrape_empty,
        scrape_failed: g.scrape_failed,
      },
    };
  });

  // Gap summary: Missing tab uses market universe (+ fund lists); Watching uses active filters.
  function buildGapSummary(pool: typeof companies) {
    return {
      missingPrice: pool.filter((c) => c.price == null).length,
      missingMcap: pool.filter((c) => c.mcap_cr == null).length,
      missingSector: pool.filter(
        (c) => !c.sector?.trim() || !c.sub_sector?.trim(),
      ).length,
      missingSubSector: pool.filter((c) => !c.sub_sector?.trim()).length,
      missingAbout: pool.filter((c) => !c.about?.trim()).length,
      missingWeb: pool.filter((c) => !c.web).length,
      missingScrape: pool.filter((c) => gapFlags(c).scrape).length,
      scrapeEmpty: pool.filter((c) => gapFlags(c).scrape_empty).length,
      scrapeFailed: pool.filter((c) => gapFlags(c).scrape_failed).length,
      scrapeBad: pool.filter((c) => {
        const g = gapFlags(c);
        return g.scrape_empty || g.scrape_failed;
      }).length,
      any: pool.filter((c) => {
        const g = gapFlags(c);
        return (
          g.price ||
          g.mcap ||
          g.sector ||
          g.sub_sector ||
          g.about ||
          g.web ||
          g.scrape
        );
      }).length,
      metrics: pool.filter((c) => c.price == null || c.mcap_cr == null).length,
    };
  }

  let gapUniverse = loadAllCompanies().filter(
    (c) => !market || market === "All" || c.market === market,
  );
  if (missing) {
    gapUniverse = mergeFundWatchlistUniverse(gapUniverse, loadAllCompanies(), {
      niveshaay,
      negen,
    });
  } else if (market === "NSE") {
    gapUniverse = loadAllCompanies().filter(
      (c) => c.market === "NSE" || c.market === "NSE SME",
    );
  }
  const gapSummary = missing
    ? buildGapSummary(gapUniverse)
    : buildGapSummary(companies);

  return NextResponse.json({
    rows: slice,
    total,
    page: pageSafe,
    pages,
    pageSize,
    markets: marketCounts(),
    sectors: distinctSectors(),
    scanPattern: scanPattern || null,
    gaps: gapSummary,
    signals: signalCounts,
    session: latestSignalDates(breakouts),
    breakoutsPreferred: !!breakoutsPreferred,
    scrape: scrapeStats ?? undefined,
  });
}
