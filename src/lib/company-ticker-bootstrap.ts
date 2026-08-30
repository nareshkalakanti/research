/**
 * Bootstrap missing NSE/BSE tickers into company_about.db from exchange + Yahoo.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { ensureCompanyAboutRow, saveYfAboutProfile } from "./company-about-write";
import { upsertClassification } from "./classifications-write";
import { invalidateCompanyCache } from "./db";
import { upsertMetrics } from "./metrics";
import { createNseBuybackSession } from "./nse-buybacks";
import { fetchQuoteDetailed, fetchYfAboutProfile } from "./yfinance";

const DATA_DIR = path.join(process.cwd(), "data");
const ABOUT_PATH = path.join(DATA_DIR, "company_about.db");
const CORP_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

const TICKER_RE = /^[A-Z][A-Z0-9-]{0,19}$/;

function companyExists(ticker: string): boolean {
  if (!fs.existsSync(ABOUT_PATH)) return false;
  const db = new Database(ABOUT_PATH, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT 1 AS ok FROM company_about WHERE UPPER(ticker) = ?`)
      .get(ticker.toUpperCase()) as { ok: number } | undefined;
    return !!row;
  } finally {
    db.close();
  }
}

async function resolveFromNse(
  ticker: string,
): Promise<{ name: string; market: string } | null> {
  try {
    const jar = await createNseBuybackSession();
    const to = new Date();
    const from = new Date(to);
    from.setFullYear(from.getFullYear() - 1);
    const dd = (d: Date) =>
      `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;

    for (const index of ["equities", "sme"] as const) {
      const u = new URL(CORP_ANN_URL);
      u.searchParams.set("index", index);
      u.searchParams.set("symbol", ticker);
      u.searchParams.set("from_date", dd(from));
      u.searchParams.set("to_date", dd(to));

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
export async function bootstrapCompanyTicker(ticker: string): Promise<boolean> {
  const key = ticker.trim().toUpperCase();
  if (!TICKER_RE.test(key)) return false;
  if (companyExists(key)) return false;

  const nse = await resolveFromNse(key);
  const name = nse?.name || key;
  const market = nse?.market || "NSE";

  if (!ensureCompanyAboutRow(key, { name, market })) return false;

  const db = new Database(ABOUT_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `UPDATE company_about SET source = 'exchange-bootstrap', fetched_at = @at WHERE ticker = @ticker`,
    ).run({ ticker: key, at: new Date().toISOString() });
  } finally {
    db.close();
  }

  try {
    const q = await fetchQuoteDetailed(key, market);
    const profile = await fetchYfAboutProfile(key, market);
    if (profile) saveYfAboutProfile(key, profile);

    const sector = profile?.sector || q?.sector || null;
    const subSector = profile?.industry?.trim() || null;
    if (sector && subSector) {
      upsertClassification(key, market, {
        sector,
        sub_sector: subSector,
        industry: subSector,
      });
    }

    if (q && (q.price != null || q.mcap_cr != null)) {
      upsertMetrics(
        [
          {
            ticker: key,
            yf_symbol: q.yf_symbol || profile?.yf_symbol,
            price: q.price,
            mcap_cr: q.mcap_cr,
            sector: sector || q.sector,
          },
        ],
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
  return TICKER_RE.test(term.trim().toUpperCase());
}
