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
  matchedTerms,
  patternMatches,
  textHasTerm,
} from "@/lib/pattern";
import { themesByIds } from "@/lib/themes";
import {
  invalidateBreakoutCache,
  loadBreakoutMap,
} from "@/lib/signals";
import { capTier, type CapTier } from "@/lib/types";

export const runtime = "nodejs";

export type { CapTier };

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.get("refresh") === "1") {
    invalidateCompanyCache();
    invalidateBreakoutCache();
  }
  const market = sp.get("market") || "NSE";
  const q = (sp.get("q") || "").trim();
  const mode = (sp.get("mode") || "OR").toUpperCase() === "AND" ? "AND" : "OR";
  const sector = sp.get("sector") || "All";
  const cap = (sp.get("cap") || "All") as CapTier | "All";
  const smeOnly = sp.get("sme") === "1";
  const filterBb = sp.get("bb") === "1";
  const filterTq = sp.get("tq") === "1";
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

  let companies = loadAllCompanies();

  if (market && market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }
  if (smeOnly) {
    companies = companies.filter((c) => c.market === "NSE SME");
  }
  if (sector && sector !== "All") {
    companies = companies.filter((c) => c.sector === sector);
  }
  if (cap && cap !== "All") {
    companies = companies.filter((c) => capTier(c.mcap_cr) === cap);
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
        // Tickers are codes — allow substring (TATA → TATAINVEST).
        if (c.ticker.toLowerCase().includes(t)) return true;
        // Names / about / sector: whole-word only (avoid parastatals → tata).
        return textHasTerm(c.search_text, t);
      };
      return mode === "AND" ? qTerms.every(hit) : qTerms.some(hit);
    });
  }

  const themePatterns = themesByIds(themeIds).map((t) => t.display_pattern);
  const scanPattern = combinePatterns([...themePatterns, custom]);
  const matchedByTheme: Record<string, string[]> = {};
  const highlightsByTicker: Record<string, string[]> = {};

  if (scan && scanPattern) {
    const hits = [];
    for (const c of companies) {
      if (patternMatches(c.search_text, scanPattern)) {
        hits.push(c);
        matchedByTheme[c.ticker] = matchedTerms(c.search_text, scanPattern);
        // Match clauses on full search_text; highlight terms that appear in About.
        highlightsByTicker[c.ticker] = matchedKeywords(
          c.about || "",
          scanPattern,
          c.search_text,
        );
      }
    }
    companies = hits;
  } else if (scan && !scanPattern) {
    companies = [];
  } else if (qTerms.length) {
    const qPattern = qTerms.join(" | ");
    for (const c of companies) {
      // Highlight only in About text — not company name / ticker.
      highlightsByTicker[c.ticker] = matchedKeywords(
        c.about || "",
        qPattern,
        c.search_text,
      );
    }
  }

  // BB / TQ chip counts for the current filter set (before signal chips / prefer).
  const signalCounts = (() => {
    let bb = 0;
    let tq = 0;
    for (const c of companies) {
      const flags = breakouts.get(c.ticker.toUpperCase());
      if (flags?.has_bb) bb += 1;
      if (flags?.has_tq) tq += 1;
    }
    return { bb, tq };
  })();

  // Explicit BB / TQ chips (OR when both on).
  if (filterBb || filterTq) {
    companies = companies.filter((c) => {
      const flags = breakouts.get(c.ticker.toUpperCase());
      const hasBb = !!flags?.has_bb;
      const hasTq = !!flags?.has_tq;
      if (filterBb && filterTq) return hasBb || hasTq;
      if (filterBb) return hasBb;
      return hasTq;
    });
  } else if (preferBreakouts && scan) {
    // Theme results: if any hit has BB or TQ, show only those.
    const withSignal = companies.filter((c) => {
      const flags = breakouts.get(c.ticker.toUpperCase());
      return !!flags?.has_bb || !!flags?.has_tq;
    });
    if (withSignal.length > 0) {
      companies = withSignal;
    }
  }

  const mul = dir === "desc" ? -1 : 1;
  const sortKey = sort as keyof (typeof companies)[number];
  companies = [...companies].sort((a, b) => {
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
    companies.length > 0 &&
    companies.every((c) => {
      const flags = breakouts.get(c.ticker.toUpperCase());
      return !!flags?.has_bb || !!flags?.has_tq;
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
      bb: flags?.bb,
      tq: flags?.tq,
      missing: {
        price: g.price,
        mcap: g.mcap,
        sector: g.sector,
        about: g.about,
        web: g.web,
      },
    };
  });

  // Gap summary over the selected market (before missing filter), for dashboard chips.
  const marketUniverse = loadAllCompanies().filter(
    (c) => !market || market === "All" || c.market === market,
  );
  const gapSummary = {
    missingPrice: marketUniverse.filter((c) => c.price == null).length,
    missingMcap: marketUniverse.filter((c) => c.mcap_cr == null).length,
    missingSector: marketUniverse.filter((c) => !c.sector?.trim()).length,
    missingAbout: marketUniverse.filter((c) => !c.about?.trim()).length,
    missingWeb: marketUniverse.filter((c) => !c.web).length,
    any: marketUniverse.filter(
      (c) =>
        c.price == null ||
        c.mcap_cr == null ||
        !c.sector?.trim() ||
        !c.about?.trim() ||
        !c.web,
    ).length,
    metrics: marketUniverse.filter((c) => c.price == null || c.mcap_cr == null)
      .length,
  };

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
    breakoutsPreferred: !!breakoutsPreferred,
  });
}
