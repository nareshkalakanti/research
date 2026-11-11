/**
 * Bootstrap missing NSE/BSE tickers into company_about.db from exchange + Yahoo.
 */
import fs from "fs";
import path from "path";
import { ensureCompanyAboutRow, saveYfAboutProfile } from "./company-about-write";
import { upsertClassification } from "./classifications-write";
import { invalidateCompanyCache } from "./db";
import { upsertMetrics } from "./metrics";
import { ensureGovernanceCompanyStub } from "./governance-write";
import { openSqliteNamed } from "./sqlite-utils";
import { createNseBuybackSession } from "./nse-buybacks";
import { fetchQuoteDetailed, fetchYfAboutProfile } from "./yfinance";
import { cacheBseScripCode } from "./bse-investor-discover";
import { fetchWebProfiles, searchGrowwListings } from "./web-mcap";
import { applyWebProfiles } from "./web-profile-apply";
import {
  formatNseApiDateFromInstant,
  istCivilDayToUtcNoon,
  istRangeDaysBack,
} from "./nse-time";

const DATA_DIR = path.join(process.cwd(), "data");
const ABOUT_PATH = path.join(DATA_DIR, "company_about.db");
const CORP_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

const TICKER_RE = /^[A-Z][A-Z0-9-]{0,19}$/;

function companyExists(ticker: string): boolean {
  if (!fs.existsSync(ABOUT_PATH)) return false;
  try {
    const db = openSqliteNamed("company_about.db", {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const row = db
        .prepare(`SELECT 1 AS ok FROM company_about WHERE UPPER(ticker) = ?`)
        .get(ticker.toUpperCase()) as { ok: number } | undefined;
      return !!row;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Governance may already have a thin BSE stub from DIN / people maps. */
function governanceCompany(
  ticker: string,
): { name: string; market: string } | null {
  try {
    const db = openSqliteNamed("governance.db", {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const row = db
        .prepare(
          `SELECT name, market FROM companies WHERE UPPER(ticker) = ?`,
        )
        .get(ticker.toUpperCase()) as
        | { name: string | null; market: string | null }
        | undefined;
      if (!row) return null;
      const name = String(row.name || "").trim();
      const market = String(row.market || "").trim();
      if (!name && !market) return null;
      return { name: name || ticker.toUpperCase(), market: market || "BSE" };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function resolveFromNse(
  ticker: string,
): Promise<{ name: string; market: string } | null> {
  try {
    const jar = await createNseBuybackSession();
    const { from: fromDay, to: toDay } = istRangeDaysBack(365);
    const to = istCivilDayToUtcNoon(toDay);
    const from = istCivilDayToUtcNoon(fromDay);

    for (const index of ["equities", "sme"] as const) {
      const u = new URL(CORP_ANN_URL);
      u.searchParams.set("index", index);
      u.searchParams.set("symbol", ticker);
      u.searchParams.set("from_date", formatNseApiDateFromInstant(from));
      u.searchParams.set("to_date", formatNseApiDateFromInstant(to));

      const res = await fetch(u.toString(), {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "application/json",
          Referer: NSE_ANN_REF,
          Cookie: jar.cookie,
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const rows = (await res.json()) as Array<{ sm_name?: string }>;
      if (!Array.isArray(rows) || !rows.length) continue;
      const name = String(rows[0]?.sm_name || "").trim();
      if (!name) continue;
      return {
        name,
        market: index === "sme" ? "NSE SME" : "NSE",
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Insert a listed ticker when searched but missing from company_about.db. */
export async function bootstrapCompanyTicker(
  ticker: string,
  opts?: { name?: string | null; market?: string | null },
): Promise<boolean> {
  const raw = ticker.trim().toUpperCase();
  if (/^\d{4,8}$/.test(raw)) {
    const hits = await searchGrowwListings(raw, 8);
    const matched = hits.filter((h) => (h.bse_scrip || "") === raw);
    const hit =
      matched.length === 1
        ? matched[0]
        : hits.length === 1 && hits[0]?.bse_scrip === raw
          ? hits[0]
          : null;
    if (hit && TICKER_RE.test(hit.ticker)) {
      if (hit.bse_scrip) cacheBseScripCode(hit.ticker, hit.bse_scrip);
      return bootstrapCompanyTicker(hit.ticker, {
        name: opts?.name || hit.name,
        market: opts?.market || hit.market,
      });
    }
    // Groww often misses bare scrip queries — BSE header ShortN (e.g. 526604 → LIPPISYS).
    const { resolveTickerFromBseScrip } = await import("./bse-investor-discover");
    const live = await resolveTickerFromBseScrip(raw);
    if (!live?.ticker || !TICKER_RE.test(live.ticker)) return false;
    return bootstrapCompanyTicker(live.ticker, {
      name: opts?.name || live.name,
      market: opts?.market || "BSE",
    });
  }
  let key = raw;
  if (!TICKER_RE.test(key)) return false;
  try {
    return await bootstrapListedTicker(key, opts);
  } catch {
    return false;
  }
}

async function bootstrapListedTicker(
  keyIn: string,
  opts?: { name?: string | null; market?: string | null },
): Promise<boolean> {
  let key = keyIn;
  if (companyExists(key)) return true;

  const hintName = (opts?.name || "").trim();
  const hintMarket = (opts?.market || "").trim().toUpperCase();
  const gov = governanceCompany(key);

  const nse = await resolveFromNse(key);
  const quoteNse = await fetchQuoteDetailed(key, nse?.market || "NSE");
  const quoteBse = await fetchQuoteDetailed(key, "BSE");
  const nseHit =
    !!nse || quoteNse.price != null || quoteNse.mcap_cr != null;
  const bseHit = quoteBse.price != null || quoteBse.mcap_cr != null;
  const usedBo = (quoteBse.yf_symbol || quoteNse.yf_symbol || "")
    .toUpperCase()
    .endsWith(".BO");
  const usedNs = (quoteNse.yf_symbol || "").toUpperCase().endsWith(".NS");

  let market = nse?.market || "";
  if (!market) {
    if (hintMarket.startsWith("BSE")) market = "BSE";
    else if (hintMarket.startsWith("NSE")) market = hintMarket;
    else if (gov?.market) market = gov.market;
    else if (bseHit && (!nseHit || (usedBo && !usedNs))) market = "BSE";
    else if (nseHit) market = "NSE";
  }

  const quote = market.startsWith("BSE") ? quoteBse : quoteNse;
  const hasQuote = quote.price != null || quote.mcap_cr != null;

  let name = nse?.name || hintName || gov?.name || key;
  let webProfiles: Awaited<ReturnType<typeof fetchWebProfiles>> = [];
  try {
    webProfiles = await fetchWebProfiles(
      [{ ticker: key, name, market: market || "BSE" }],
      { concurrency: 1, delayMs: 80 },
    );
    const p = webProfiles[0];
    if (p?.matched_name) name = p.matched_name;
    const listed = (p?.listed_ticker || "")
      .toUpperCase()
      .replace(/-EQ$/i, "");
    if (listed && TICKER_RE.test(listed)) key = listed;
    const ex = (p?.exchange || "").toUpperCase();
    if (hintMarket.startsWith("BSE") && p?.bse_tradable) market = "BSE";
    else if (p?.bse_tradable && !p?.nse_tradable) market = "BSE";
    else if (!nse && ex.includes("BSE")) market = "BSE";
    else if (!nse && ex.includes("NSE") && !ex.includes("BSE")) market = "NSE";
    if (p?.bse_scrip) cacheBseScripCode(key, p.bse_scrip);
  } catch {
    /* name/exchange from Yahoo is enough */
  }
  if (!market) market = usedBo ? "BSE" : "NSE";

  const searched = keyIn.trim().toUpperCase();
  if (key !== searched && companyExists(searched)) {
    try {
      const dbDrop = openSqliteNamed("company_about.db", {
        readonly: false,
        wal: false,
      });
      try {
        dbDrop.prepare(`DELETE FROM company_about WHERE ticker = ?`).run(searched);
      } finally {
        dbDrop.close();
      }
    } catch {
      /* about write optional */
    }
    try {
      const mdb = openSqliteNamed("metrics.db", { readonly: false, wal: true });
      try {
        mdb.prepare(`DELETE FROM stock_metrics WHERE ticker = ?`).run(searched);
      } finally {
        mdb.close();
      }
    } catch {
      /* metrics row optional */
    }
  }

  if (companyExists(key)) return true;

  const webOk = webProfiles.some(
    (p) => p.matched_name || p.mcap_cr != null || p.price != null,
  );
  // Thin BSE / DIN stubs often have no Yahoo quote — still add when the
  // caller named the company or governance already has the listing.
  const namedOk = hintName.length >= 3 || !!gov;
  if (!nse && !hasQuote && !webOk && !namedOk) return false;
  if (!ensureCompanyAboutRow(key, { name, market })) return false;

  ensureGovernanceCompanyStub({ ticker: key, name, market });

  try {
    const db = openSqliteNamed("company_about.db", {
      readonly: false,
      wal: false,
    });
    try {
      db.prepare(
        `UPDATE company_about SET source = 'exchange-bootstrap', fetched_at = @at WHERE ticker = @ticker`,
      ).run({ ticker: key, at: new Date().toISOString() });
    } finally {
      db.close();
    }
  } catch {
    /* listing is already in rotation even if about write fails */
  }

  try {
    const profile = await fetchYfAboutProfile(key, market);
    if (profile) saveYfAboutProfile(key, profile);

    const sector = profile?.sector || quote.sector || null;
    const subSector = profile?.industry?.trim() || null;
    if (sector && subSector) {
      upsertClassification(key, market, {
        sector,
        sub_sector: subSector,
        industry: subSector,
      });
    }

    if (hasQuote) {
      upsertMetrics(
        [
          {
            ticker: key,
            yf_symbol: quote.yf_symbol || profile?.yf_symbol,
            price: quote.price,
            mcap_cr: quote.mcap_cr,
            sector: sector || quote.sector,
          },
        ],
        { [key]: market },
      );
    }
    if (webProfiles.length) {
      applyWebProfiles(
        webProfiles.map((p) => ({ ...p, ticker: key })),
        { [key]: market },
      );
    }
  } catch {
    /* row exists; enrichment optional */
  }

  invalidateCompanyCache();
  return true;
}

export function looksLikeTickerSearch(term: string): boolean {
  const t = term.trim().toUpperCase();
  return TICKER_RE.test(t) || /^\d{4,8}$/.test(t);
}
