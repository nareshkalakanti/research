import { NextRequest, NextResponse } from "next/server";
import { bootstrapCompanyTicker } from "@/lib/company-ticker-bootstrap";
import { invalidateCompanyCache, loadAllCompanies } from "@/lib/db";
import {
  companyLabelKey,
  listingCorpusMatches,
  listingQueryMatches,
  listingQueryVariants,
  rankListingQuery,
  shouldAugmentListingSearch,
} from "@/lib/listing-name-match";
import {
  tickerFromBseScrip,
  resolveTickerFromBseScrip,
} from "@/lib/bse-investor-discover";
import { searchBseEquityListings } from "@/lib/bse-sme";
import { openSqliteNamed } from "@/lib/sqlite-utils";
import { searchGrowwListings } from "@/lib/web-mcap";

export const runtime = "nodejs";

export type TickerHit = {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  mcap_cr: number | null;
  source?: "local" | "groww";
};

function listingMatches(
  q: string,
  ticker: string,
  name: string,
  corpus?: string | null,
): boolean {
  if (listingQueryMatches(q, ticker, name)) return true;
  return Boolean(corpus && listingCorpusMatches(q, corpus));
}

function rankHit(
  q: string,
  h: TickerHit,
  corpus?: string | null,
): number {
  return rankListingQuery(q, h.ticker, h.name, corpus);
}

function localHits(q: string, limit: number): TickerHit[] {
  const hits: TickerHit[] = [];
  const have = new Set<string>();
  const corpusByTicker = new Map<string, string>();
  const push = (row: TickerHit, corpus?: string | null) => {
    const ticker = row.ticker.toUpperCase();
    if (have.has(ticker)) return;
    have.add(ticker);
    if (corpus) corpusByTicker.set(ticker, corpus);
    hits.push({ ...row, ticker });
  };

  const companies = loadAllCompanies();
  // BSE scrip code → ticker (e.g. 526604 → LIPPISYS / formerly Lippi Systems).
  if (/^\d{5,7}$/.test(q.trim())) {
    const fromScrip = tickerFromBseScrip(q.trim());
    if (fromScrip) {
      const co = companies.find((c) => c.ticker.toUpperCase() === fromScrip);
      push(
        {
          ticker: fromScrip,
          name: co?.name || fromScrip,
          market: co?.market || "BSE",
          sector: co?.sector || null,
          mcap_cr:
            co?.mcap_cr != null && Number.isFinite(co.mcap_cr)
              ? co.mcap_cr
              : null,
          source: "local",
        },
        co?.search_text || null,
      );
    }
  }
  // Pass 1: ticker + name substring only (no fuzzy score — typeahead speed).
  for (const c of companies) {
    const ticker = String(c.ticker || "").toUpperCase();
    const name = String(c.name || "").trim();
    if (!ticker) continue;
    if (!listingQueryMatches(q, ticker, name, { fuzzy: false })) continue;
    const corpus = String(c.search_text || "");
    push(
      {
        ticker,
        name: name || ticker,
        market: String(c.market || ""),
        sector: c.sector || null,
        mcap_cr:
          c.mcap_cr != null && Number.isFinite(c.mcap_cr) ? c.mcap_cr : null,
        source: "local",
      },
      corpus || null,
    );
  }
  // Former-name / brand corpus: only when ticker/name miss (e.g. "barbeque").
  // Skip when pass1 already found listings — keeps typeahead snappy.
  const corpusKey = companyLabelKey(q);
  const wantCorpus =
    hits.length === 0 &&
    (corpusKey.includes(" ") ||
      corpusKey.split(" ").some((w) => w.length >= 7));
  if (wantCorpus) {
    for (const c of companies) {
      const ticker = String(c.ticker || "").toUpperCase();
      if (!ticker || have.has(ticker)) continue;
      const name = String(c.name || "").trim();
      const corpus = String(c.search_text || "");
      if (!corpus || !listingCorpusMatches(q, corpus)) continue;
      push(
        {
          ticker,
          name: name || ticker,
          market: String(c.market || ""),
          sector: c.sector || null,
          mcap_cr:
            c.mcap_cr != null && Number.isFinite(c.mcap_cr) ? c.mcap_cr : null,
          source: "local",
        },
        corpus,
      );
    }
  }
  try {
    const db = openSqliteNamed("governance.db", {
      readonly: true,
      fileMustExist: true,
    });
    const rows = db
      .prepare(`SELECT ticker, name, market FROM companies`)
      .all() as Array<{ ticker: string; name: string; market: string }>;
    db.close();
    for (const c of rows) {
      const ticker = String(c.ticker || "").toUpperCase();
      const name = String(c.name || "").trim();
      if (!ticker || !listingQueryMatches(q, ticker, name, { fuzzy: false })) {
        continue;
      }
      push({
        ticker,
        name: name || ticker,
        market: String(c.market || ""),
        sector: null,
        mcap_cr: null,
        source: "local",
      });
    }
  } catch {
    /* about rows still usable */
  }
  // Metrics / classifications cover tickers missing from company_about (e.g. BSE FINELINE).
  try {
    const classSector = new Map<string, string>();
    try {
      const cdb = openSqliteNamed("classifications.db", {
        readonly: true,
        fileMustExist: true,
      });
      const crows = cdb
        .prepare(
          `SELECT ticker, market, sector, industry, sub_sector FROM classifications`,
        )
        .all() as Array<{
        ticker: string;
        market: string | null;
        sector: string | null;
        industry: string | null;
        sub_sector: string | null;
      }>;
      cdb.close();
      for (const r of crows) {
        const ticker = String(r.ticker || "").toUpperCase();
        if (!ticker || have.has(ticker)) continue;
        if (!listingQueryMatches(q, ticker, ticker, { fuzzy: false })) continue;
        const sector =
          String(r.industry || r.sub_sector || r.sector || "").trim() || null;
        if (sector) classSector.set(ticker, sector);
        push({
          ticker,
          name: ticker,
          market: String(r.market || "").trim() || "NSE",
          sector,
          mcap_cr: null,
          source: "local",
        });
      }
    } catch {
      /* optional */
    }
    const mdb = openSqliteNamed("metrics.db", {
      readonly: true,
      fileMustExist: true,
    });
    const mrows = mdb
      .prepare(
        `SELECT ticker, market, market_cap_cr, sector FROM stock_metrics`,
      )
      .all() as Array<{
      ticker: string;
      market: string | null;
      market_cap_cr: number | null;
      sector: string | null;
    }>;
    mdb.close();
    for (const r of mrows) {
      const ticker = String(r.ticker || "").toUpperCase();
      if (!ticker || have.has(ticker)) continue;
      if (!listingQueryMatches(q, ticker, ticker, { fuzzy: false })) continue;
      const mcap =
        r.market_cap_cr != null && Number.isFinite(r.market_cap_cr)
          ? r.market_cap_cr
          : null;
      push({
        ticker,
        name: ticker,
        market: String(r.market || "").trim() || "NSE",
        sector: classSector.get(ticker) || String(r.sector || "").trim() || null,
        mcap_cr: mcap,
        source: "local",
      });
    }
  } catch {
    /* metrics optional */
  }
  hits.sort((a, b) => {
    const ra = rankHit(q, a, corpusByTicker.get(a.ticker));
    const rb = rankHit(q, b, corpusByTicker.get(b.ticker));
    if (ra !== rb) return ra - rb;
    return a.ticker.localeCompare(b.ticker);
  });
  return hits.slice(0, limit);
}

function toHit(
  c: ReturnType<typeof loadAllCompanies>[number] | undefined,
  fallback: TickerHit,
): TickerHit {
  if (!c) return fallback;
  return {
    ticker: c.ticker.toUpperCase(),
    name: c.name || c.ticker,
    market: c.market || fallback.market,
    sector: c.sector || null,
    mcap_cr:
      c.mcap_cr != null && Number.isFinite(c.mcap_cr) ? c.mcap_cr : null,
    source: "local",
  };
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.& -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const limit = Math.min(
    30,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 12) || 12),
  );

  if (q.length < 1) {
    return NextResponse.json({ ok: true, q, hits: [] as TickerHit[] });
  }

  const remoteParam = (req.nextUrl.searchParams.get("remote") || "")
    .trim()
    .toLowerCase();
  /** Typeahead passes remote=0; other callers keep Groww fill-in. */
  const allowRemote = !(
    remoteParam === "0" ||
    remoteParam === "false" ||
    remoteParam === "local"
  );

  let hits: TickerHit[] = [];
  let corpusByTicker = new Map<string, string>();
  try {
    hits = localHits(q, limit);
    // Reuse about rows already loaded inside localHits via cache.
    for (const c of loadAllCompanies()) {
      const t = String(c.ticker || "").toUpperCase();
      if (t && c.search_text) corpusByTicker.set(t, c.search_text);
    }
  } catch (err) {
    console.warn(
      "[tickers] local listings unavailable:",
      err instanceof Error ? err.message : err,
    );
  }
  // Live BSE when scrip isn't cached yet (Sector fill / typeahead).
  // PeerSmartSearch is usually faster than getScripHeaderData.
  if (!hits.length && /^\d{5,7}$/.test(q)) {
    try {
      const peer = await searchBseEquityListings(q, 3);
      const hit = peer[0];
      if (hit?.ticker) {
        try {
          await bootstrapCompanyTicker(hit.ticker, {
            name: hit.name,
            market: "BSE",
          });
          const { cacheBseScripCode } = await import(
            "@/lib/bse-investor-discover"
          );
          cacheBseScripCode(hit.ticker, hit.bse_scrip || q);
          invalidateCompanyCache();
        } catch {
          /* row may already exist */
        }
        const co = loadAllCompanies().find(
          (c) => c.ticker.toUpperCase() === hit.ticker,
        );
        const coName = String(co?.name || "").trim();
        const peerName = String(hit.name || "").trim();
        const name = (
          coName && coName.toUpperCase() !== hit.ticker
            ? coName
            : peerName || coName || hit.ticker
        ).replace(/-\$$/, "");
        hits = [
          {
            ticker: hit.ticker,
            name,
            market: co?.market || "BSE",
            sector: co?.sector || null,
            mcap_cr:
              co?.mcap_cr != null && Number.isFinite(co.mcap_cr)
                ? co.mcap_cr
                : null,
            source: "local",
          },
        ];
      }
    } catch (err) {
      console.warn(
        "[tickers] BSE peer scrip search failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (!hits.length && /^\d{5,7}$/.test(q)) {
    try {
      const live = await resolveTickerFromBseScrip(q);
      if (live?.ticker) {
        try {
          await bootstrapCompanyTicker(live.ticker, {
            name: live.name,
            market: "BSE",
          });
          invalidateCompanyCache();
        } catch {
          /* row may already exist */
        }
        const co = loadAllCompanies().find(
          (c) => c.ticker.toUpperCase() === live.ticker,
        );
        hits = [
          {
            ticker: live.ticker,
            name: (co?.name || live.name || live.ticker).replace(/-\$$/, "").trim(),
            market: co?.market || "BSE",
            sector: co?.sector || null,
            mcap_cr:
              co?.mcap_cr != null && Number.isFinite(co.mcap_cr)
                ? co.mcap_cr
                : null,
            source: "local",
          },
        ];
      }
    } catch (err) {
      console.warn(
        "[tickers] BSE scrip resolve failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const have = new Set(hits.map((h) => h.ticker));
  if (allowRemote && shouldAugmentListingSearch(q, hits, limit)) {
    try {
      const remote = await searchGrowwListings(q, limit);
      for (const r of remote) {
        if (have.has(r.ticker)) {
          // Metrics/classifications often only know the symbol — fill Groww name.
          const existing = hits.find((h) => h.ticker === r.ticker);
          if (
            existing &&
            r.name &&
            (!existing.name || existing.name === existing.ticker)
          ) {
            existing.name = r.name;
            if (r.market) existing.market = r.market;
          }
          continue;
        }
        if (!listingMatches(q, r.ticker, r.name)) continue;
        have.add(r.ticker);
        hits.push({
          ticker: r.ticker,
          name: r.name,
          market: r.market,
          sector: null,
          mcap_cr: null,
          source: "groww",
        });
      }
    } catch {
      /* local hits still usable */
    }
    // BSE PeerSmartSearch covers suspended / thin names Groww skips.
    // Also try OCR n↔m query variants (Aagan → Aagam).
    try {
      const bseQueries = listingQueryVariants(q).slice(0, 4);
      for (const bq of bseQueries) {
        if (hits.length >= limit) break;
        const remote = await searchBseEquityListings(bq, limit);
        for (const r of remote) {
          if (have.has(r.ticker)) continue;
          if (
            !listingMatches(q, r.ticker, r.name) &&
            !listingMatches(bq, r.ticker, r.name)
          ) {
            continue;
          }
          have.add(r.ticker);
          hits.push({
            ticker: r.ticker,
            name: r.name,
            market: r.market,
            sector: null,
            mcap_cr: null,
            source: "groww",
          });
          try {
            await bootstrapCompanyTicker(r.ticker, {
              name: r.name,
              market: "BSE",
            });
            if (r.bse_scrip) {
              const { cacheBseScripCode } = await import(
                "@/lib/bse-investor-discover"
              );
              cacheBseScripCode(r.ticker, r.bse_scrip);
            }
            invalidateCompanyCache();
          } catch {
            /* best-effort */
          }
          if (hits.length >= limit) break;
        }
      }
    } catch {
      /* groww / local still usable */
    }
  }

  hits.sort((a, b) => {
    const ra = rankHit(q, a, corpusByTicker.get(a.ticker));
    const rb = rankHit(q, b, corpusByTicker.get(b.ticker));
    if (ra !== rb) return ra - rb;
    if ((a.source || "local") !== (b.source || "local")) {
      return (a.source || "local") === "local" ? -1 : 1;
    }
    const ma = a.mcap_cr ?? -1;
    const mb = b.mcap_cr ?? -1;
    if (ma !== mb) return mb - ma;
    return a.ticker.localeCompare(b.ticker);
  });

  return NextResponse.json({
    ok: true,
    q,
    hits: hits.slice(0, limit),
  });
}

/** Add a Groww/exchange listing into company_about so DIN / people can attach. */
export async function POST(req: NextRequest) {
  let body: { ticker?: string; name?: string; market?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const ticker = (body.ticker || "").trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  let before = new Set<string>();
  try {
    before = new Set(loadAllCompanies().map((c) => c.ticker.toUpperCase()));
  } catch {
    /* about db may be briefly unreadable */
  }
  let ok = false;
  try {
    ok = await bootstrapCompanyTicker(ticker, {
      name: body.name || ticker,
      market: body.market || null,
    });
    invalidateCompanyCache();
  } catch (err) {
    console.warn(
      "[tickers] bootstrap skipped:",
      err instanceof Error ? err.message : err,
    );
  }
  let all: ReturnType<typeof loadAllCompanies> = [];
  try {
    all = loadAllCompanies();
  } catch {
    all = [];
  }
  let co =
    all.find((c) => c.ticker.toUpperCase() === ticker) ||
    all.find(
      (c) =>
        (body.name || "").trim() &&
        c.name.toLowerCase() === String(body.name || "").trim().toLowerCase(),
    );
  // Thin BSE / DIN stubs: bootstrap may report ok via a remapped symbol, or
  // a concurrent About reopen may miss the row — force the requested ticker.
  if (!co) {
    try {
      const { ensureCompanyAboutRow } = await import(
        "@/lib/company-about-write"
      );
      const { ensureGovernanceCompanyStub } = await import(
        "@/lib/governance-write"
      );
      const name = (body.name || ticker).trim() || ticker;
      const market = (body.market || "BSE").trim() || "BSE";
      if (ensureCompanyAboutRow(ticker, { name, market })) {
        ensureGovernanceCompanyStub({ ticker, name, market });
        invalidateCompanyCache();
        all = loadAllCompanies();
        co = all.find((c) => c.ticker.toUpperCase() === ticker) ?? null;
      }
    } catch (err) {
      console.warn(
        "[tickers] about stub skipped:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const hit = toHit(co, {
    ticker,
    name: body.name || ticker,
    market: body.market || "",
    sector: null,
    mcap_cr: null,
    source: "local",
  });
  // Must land the requested ticker in company_about — never fake ok.
  if (!co || co.ticker.toUpperCase() !== ticker) {
    return NextResponse.json(
      {
        ok: false,
        error: "Could not add listing from Groww / exchange",
        hit,
      },
      { status: 422 },
    );
  }
  void ok;
  void before;
  return NextResponse.json({ ok: true, hit });
}
