import { NextRequest, NextResponse } from "next/server";
import {
  distinctSectors,
  invalidateCompanyCache,
  loadAllCompanies,
  marketCounts,
} from "@/lib/db";
import {
  combinePatterns,
  matchedKeywords,
  textHasTerm,
  tickerMatchesSearch,
} from "@/lib/pattern";
import { themesByIds } from "@/lib/themes";
import { matchThemesForRow } from "@/lib/theme-match";
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
import { capTier, type CapTier } from "@/lib/types";

export const runtime = "nodejs";

export type { CapTier };

export async function GET(req: NextRequest) {
  try {
    return buildCompaniesResponse(req);
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

function buildCompaniesResponse(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.get("refresh") === "1") {
    invalidateCompanyCache();
    invalidateBreakoutCache();
    invalidateHoldingsCache();
    invalidateEdgeCache();
    invalidateFundWatchlistCache();
    invalidateNotesCache();
  }
  const market = sp.get("market") || "NSE";
  const q = (sp.get("q") || "").trim();
  const mode = (sp.get("mode") || "OR").toUpperCase() === "AND" ? "AND" : "OR";
  const sector = sp.get("sector") || "All";
  const cap = (sp.get("cap") || "All") as CapTier | "All";
  const filterSme = sp.get("sme") === "1";
  const filterBb = sp.get("bb") === "1";
  const filterTq = sp.get("tq") === "1";
  const filterEma = sp.get("ema") === "1";
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
  const page = Math.max(1, Number(sp.get("page") || 1));
  const pageSize = Math.min(200, Math.max(10, Number(sp.get("pageSize") || 100)));
  const sort = sp.get("sort") || "sector";
  const dir = sp.get("dir") === "desc" ? "desc" : "asc";
  const scan = sp.get("scan") === "1";
  const missing = (sp.get("missing") || "").trim().toLowerCase();

  const breakouts = loadBreakoutMap();
  const holdings = holdingsTickerSet();
  const distressSet = distressSeedSet();
  const edge = edgeTickerSet();
  const niveshaay = niveshaayTickerSet();
  const negen = negenTickerSet();
  const fundCounts = fundWatchlistCounts();
  const notes = notesTickerSet();

  let companies = loadAllCompanies();
  const allCompanies = companies;

  // Hold / Edge / Notes are cross-market lists — don't hide SME/BSE when those chips are on.
  const watchlistMode =
    filterHold ||
    filterDistress ||
    filterEdge ||
    filterNiveshaay ||
    filterNegen ||
    filterSme ||
    filterNote;
  if (!watchlistMode && market && market !== "All") {
    // Theme scan + Watching search on NSE also check NSE SME (Sunlite, Vilas, …).
    if (market === "NSE" && (scan || q.trim())) {
      companies = companies.filter(
        (c) => c.market === "NSE" || c.market === "NSE SME",
      );
    } else {
      companies = companies.filter((c) => c.market === market);
    }
  }
  if (sector && sector !== "All") {
    companies = companies.filter((c) => c.sector === sector);
  }
  if (cap && cap !== "All") {
    companies = companies.filter((c) => capTier(c.mcap_cr) === cap);
  }

  // Missing-data tab: always surface fund watchlist names (often BSE) even on NSE list.
  if (missing) {
    companies = mergeFundWatchlistUniverse(companies, allCompanies, {
      niveshaay,
      negen,
    });
  }

  function gapFlags(c: (typeof companies)[number]) {
    return {
      price: c.price == null,
      mcap: c.mcap_cr == null,
      sector: !c.sector?.trim(),
      about: !c.about?.trim(),
      web: !c.web,
    };
  }

  if (missing) {
    companies = companies.filter((c) => {
      const g = gapFlags(c);
      if (missing === "any") {
        return g.price || g.mcap || g.sector || g.about || g.web;
      }
      if (missing === "price") return g.price;
      if (missing === "mcap") return g.mcap;
      if (missing === "sector") return g.sector;
      if (missing === "about") return g.about;
      if (missing === "web") return g.web;
      if (missing === "metrics") return g.price || g.mcap;
      return true;
    });
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

  const selectedThemes = themesByIds(themeIds);
  const themePatterns = selectedThemes.map((t) => t.display_pattern);
  const scanPattern = combinePatterns([...themePatterns, custom]);
  const matchedByTheme: Record<string, string[]> = {};
  const highlightsByTicker: Record<string, string[]> = {};

  if (scan && (selectedThemes.length > 0 || custom.trim())) {
    const hits = [];
    for (const c of companies) {
      const result = matchThemesForRow(c, selectedThemes, {
        customPattern: custom.trim() || null,
      });
      if (!result.matched) continue;
      hits.push(c);
      matchedByTheme[c.ticker] = result.matchedTerms;
      highlightsByTicker[c.ticker] = result.highlights;
    }
    companies = hits;
  } else if (scan && !scanPattern && !fundListMode) {
    companies = [];
  } else if (qTerms.length) {
    const qPattern = qTerms.join(" | ");
    for (const c of companies) {
      // Highlight only in About text — not company name / ticker.
      highlightsByTicker[c.ticker] = matchedKeywords(
        [c.about, c.headquarters].filter(Boolean).join("\n"),
        qPattern,
        c.search_text,
      );
    }
  }

  // Signal counts for current list — NSE counts include NSE SME when listing NSE.
  const signalCounts = (() => {
    let pool = allCompanies;
    if (!watchlistMode && market && market !== "All") {
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
    let hold = 0;
    let edgeCount = 0;
    let smeCount = 0;
    let note = 0;
    let distressCount = 0;
    for (const c of pool) {
      const t = c.ticker.toUpperCase();
      const flags = breakouts.get(t);
      if (flags?.has_bb) bb += 1;
      if (flags?.has_tq) tq += 1;
      if (flags?.has_ema) ema += 1;
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
      hold,
      edge: edgeCount,
      niveshaay: fundCounts.niveshaay,
      negen: fundCounts.negen,
      sme: smeCount,
      note,
      distress: distressCount,
    };
  })();

  if (filterSme) {
    companies = companies.filter((c) => /\bSME\b/i.test(c.market));
  }

  if (filterHold) {
    companies = companies.filter((c) =>
      holdings.has(c.ticker.toUpperCase()),
    );
  }

  if (filterDistress) {
    companies = companies.filter((c) =>
      distressSet.has(c.ticker.toUpperCase()),
    );
  }

  if (filterEdge) {
    companies = companies.filter((c) => edge.has(c.ticker.toUpperCase()));
  }

  const fundFilter = activeFundFilterSet(niveshaay, negen, {
    niveshaay: filterNiveshaay,
    negen: filterNegen,
  });
  if (fundFilter) {
    companies = companies.filter((c) =>
      fundFilter.has(c.ticker.toUpperCase()),
    );
    companies = appendFundWatchlistStubs(companies, fundFilter, allCompanies);
  }

  if (filterNote) {
    companies = companies.filter((c) => notes.has(c.ticker.toUpperCase()));
  }

  // BB/TQ/EMA narrows scan results — skip when viewing a fund watchlist (Negen / Niveshaay).
  if ((filterBb || filterTq || filterEma) && !fundListMode) {
    companies = companies.filter((c) => {
      const flags = breakouts.get(c.ticker.toUpperCase());
      const hasBb = !!flags?.has_bb;
      const hasTq = !!flags?.has_tq;
      const hasEma = !!flags?.has_ema;
      if (filterBb && filterTq && filterEma) {
        if (bbAnd) return hasBb && hasTq && hasEma;
        return hasBb || hasTq || hasEma;
      }
      if (filterBb && filterTq && bbAnd) return hasBb && hasTq;
      if (filterBb && filterTq) return hasBb || hasTq;
      if (filterBb && filterEma) return hasBb || hasEma;
      if (filterTq && filterEma) return hasTq || hasEma;
      if (filterBb) return hasBb;
      if (filterTq) return hasTq;
      return hasEma;
    });
  } else if (preferBreakouts && scan) {
    // Theme results: if any hit has BB, TQ, or EMA, show only those.
    const withSignal = companies.filter((c) => {
      const flags = breakouts.get(c.ticker.toUpperCase());
      return !!flags?.has_bb || !!flags?.has_tq || !!flags?.has_ema;
    });
    if (withSignal.length > 0) {
      companies = withSignal;
    }
  }

  const mul = dir === "desc" ? -1 : 1;
  companies = [...companies].sort((a, b) => {
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
    companies.length > 0 &&
    companies.every((c) => {
      const flags = breakouts.get(c.ticker.toUpperCase());
      return !!flags?.has_bb || !!flags?.has_tq || !!flags?.has_ema;
    });

  const total = companies.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pageSafe = Math.min(page, pages);
  const start = (pageSafe - 1) * pageSize;
  const slice = companies.slice(start, start + pageSize).map((c) => {
    const { search_text: _, ...rest } = c;
    const g = gapFlags(c);
    const flags = breakouts.get(c.ticker.toUpperCase());
    return {
      ...rest,
      matched: matchedByTheme[c.ticker] ?? [],
      highlights: highlightsByTicker[c.ticker] ?? [],
      has_bb: !!flags?.has_bb,
      has_tq: !!flags?.has_tq,
      has_ema: !!flags?.has_ema,
      has_hold: holdings.has(c.ticker.toUpperCase()),
      has_distress: distressSet.has(c.ticker.toUpperCase()),
      has_edge: edge.has(c.ticker.toUpperCase()),
      has_niveshaay: niveshaay.has(c.ticker.toUpperCase()),
      has_negen: negen.has(c.ticker.toUpperCase()),
      has_note: notes.has(c.ticker.toUpperCase()),
      bb: flags?.bb,
      tq: flags?.tq,
      ema: flags?.ema,
      missing: {
        price: g.price,
        mcap: g.mcap,
        sector: g.sector,
        about: g.about,
        web: g.web,
      },
    };
  });

  // Gap summary: Missing tab uses market universe (+ fund lists); Watching uses active filters.
  function buildGapSummary(pool: typeof companies) {
    return {
      missingPrice: pool.filter((c) => c.price == null).length,
      missingMcap: pool.filter((c) => c.mcap_cr == null).length,
      missingSector: pool.filter((c) => !c.sector?.trim()).length,
      missingAbout: pool.filter((c) => !c.about?.trim()).length,
      missingWeb: pool.filter((c) => !c.web).length,
      any: pool.filter(
        (c) =>
          c.price == null ||
          c.mcap_cr == null ||
          !c.sector?.trim() ||
          !c.about?.trim() ||
          !c.web,
      ).length,
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
    session: latestSignalDates(),
    breakoutsPreferred: !!breakoutsPreferred,
  });
}
