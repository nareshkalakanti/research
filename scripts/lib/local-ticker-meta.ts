/**
 * Resolve ticker name / market from local research DBs only.
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DATA = path.join(process.cwd(), "data");

export function resolveTickerMeta(ticker: string): {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  industry: string | null;
} {
  const t = ticker.trim().toUpperCase();
  const aboutPath = path.join(DATA, "company_about.db");
  const classPath = path.join(DATA, "classifications.db");

  let name = t;
  let market = "NSE";
  let sector: string | null = null;
  let industry: string | null = null;

  if (fs.existsSync(aboutPath)) {
    const about = new Database(aboutPath, { readonly: true, fileMustExist: true });
    try {
      const row = about
        .prepare(
          `SELECT ticker, name, market, company_sector, company_industry
           FROM company_about WHERE UPPER(ticker) = ? LIMIT 1`,
        )
        .get(t) as
        | {
            name: string | null;
            market: string | null;
            company_sector: string | null;
            company_industry: string | null;
          }
        | undefined;
      if (row) {
        name = row.name?.trim() || t;
        market = row.market?.trim() || market;
        sector = row.company_sector?.trim() || null;
        industry = row.company_industry?.trim() || null;
      }
    } finally {
      about.close();
    }
  }

  if (fs.existsSync(classPath)) {
    const cls = new Database(classPath, { readonly: true, fileMustExist: true });
    try {
      const row = cls
        .prepare(
          `SELECT sector, industry, sub_sector, market
           FROM classifications
           WHERE UPPER(ticker) = ?
           ORDER BY CASE WHEN market = ? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(t, market) as
        | {
            sector: string | null;
            industry: string | null;
            sub_sector: string | null;
            market: string | null;
          }
        | undefined;
      if (row) {
        sector = row.sector?.trim() || sector;
        industry = row.industry?.trim() || row.sub_sector?.trim() || industry;
        market = row.market?.trim() || market;
      }
    } finally {
      cls.close();
    }
  }

  return { ticker: t, name, market: market.toUpperCase(), sector, industry };
}
