/** Listing venue from local DBs — server only (do not import from client components). */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/sqlite-utils";

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function readMarketColumn(
  file: string,
  sql: string,
  ticker: string,
): string | null {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(p, { readonly: true, fileMustExist: true });
    const row = db.prepare(sql).get(ticker) as { market?: string | null } | undefined;
    return clean(row?.market) || null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function hasBseScrip(ticker: string): boolean {
  const p = path.join(DATA_DIR, "company_about.db");
  if (!fs.existsSync(p)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(p, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM company_bse_scrip WHERE UPPER(ticker) = ? LIMIT 1`,
      )
      .get(ticker) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** NSE / BSE / SME string from about, metrics, holdings, named lists, or BSE scrip. */
export function resolveListingMarket(ticker: string): string | null {
  const t = ticker.trim().toUpperCase();
  if (!t) return null;
  return (
    readMarketColumn(
      "company_about.db",
      `SELECT market FROM company_about WHERE UPPER(ticker) = ? LIMIT 1`,
      t,
    ) ||
    readMarketColumn(
      "metrics.db",
      `SELECT market FROM stock_metrics WHERE UPPER(ticker) = ? LIMIT 1`,
      t,
    ) ||
    readMarketColumn(
      "holdings.db",
      `SELECT market FROM holdings WHERE UPPER(ticker) = ? LIMIT 1`,
      t,
    ) ||
    readMarketColumn(
      "named_watchlists.db",
      `SELECT market FROM named_watchlists
       WHERE UPPER(ticker) = ? AND TRIM(COALESCE(market, '')) != ''
       LIMIT 1`,
      t,
    ) ||
    (hasBseScrip(t) ? "BSE" : null)
  );
}
