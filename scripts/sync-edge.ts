/**
 * Merge Early Edge + Negen + Niveshaay from stocks-ai into data/edge.db.
 * Also upserts missing Edge tickers into company_about.db so BSE names show up.
 *
 *   npm run sync:edge
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { replaceEdge } from "../src/lib/edge";

const SOURCE_KEYS = ["early_edge", "negen", "niveshaay"] as const;

const CANDIDATES = [
  path.join(process.cwd(), "..", "stocks-ai", "data", "stocks_ai.db"),
  path.join(
    process.env.HOME || "",
    "Development/ai.com/stocks-ai/data/stocks_ai.db",
  ),
];

function findSource(): string {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `stocks_ai.db not found. Tried:\n${CANDIDATES.map((p) => `  ${p}`).join("\n")}`,
  );
}

function upsertMissingAbout(
  src: Database.Database,
  rows: Array<{
    ticker: string;
    name: string | null;
    market: string | null;
  }>,
): number {
  const aboutPath = path.join(process.cwd(), "data", "company_about.db");
  if (!fs.existsSync(aboutPath)) {
    console.warn("company_about.db missing — skip universe upsert");
    return 0;
  }

  const about = new Database(aboutPath);
  try {
    const have = new Set(
      (
        about.prepare(`SELECT UPPER(ticker) AS t FROM company_about`).all() as Array<{
          t: string;
        }>
      ).map((r) => r.t),
    );

    const stockStmt = src.prepare(
      `SELECT ticker, name, market, sector, industry
       FROM stocks WHERE UPPER(ticker) = ? LIMIT 1`,
    );
    const ins = about.prepare(`
      INSERT INTO company_about (
        ticker, name, market, website, about, yf_about, scraped_about,
        company_sector, company_industry, headquarters,
        products, end_markets, theme_tags, source, fetched_at,
        has_website, has_yf_about, has_scraped_about
      ) VALUES (
        @ticker, @name, @market, NULL, NULL, NULL, NULL,
        @sector, @industry, NULL,
        NULL, NULL, NULL, 'edge-sync', @fetched_at,
        0, 0, 0
      )
    `);

    const now = new Date().toISOString();
    let n = 0;
    const tx = about.transaction(() => {
      for (const r of rows) {
        const ticker = (r.ticker || "").trim().toUpperCase();
        if (!ticker || have.has(ticker)) continue;

        const stock = stockStmt.get(ticker) as
          | {
              ticker: string;
              name: string | null;
              market: string | null;
              sector: string | null;
              industry: string | null;
            }
          | undefined;

        const market = (stock?.market || r.market || "BSE").toUpperCase();
        const name = (stock?.name || r.name || ticker).trim();

        ins.run({
          ticker,
          name,
          market,
          sector: stock?.sector?.trim() || null,
          industry: stock?.industry?.trim() || null,
          fetched_at: now,
        });
        have.add(ticker);
        n += 1;
      }
    });
    tx();
    return n;
  } finally {
    about.close();
  }
}

function main() {
  const srcPath = findSource();
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  const placeholders = SOURCE_KEYS.map(() => "?").join(",");
  const raw = src
    .prepare(
      `
      SELECT UPPER(ticker) AS ticker,
             MAX(name) AS name,
             MAX(market) AS market,
             GROUP_CONCAT(DISTINCT list_key) AS sources
      FROM fund_watchlists
      WHERE list_key IN (${placeholders})
      GROUP BY UPPER(ticker)
      ORDER BY ticker
      `,
    )
    .all(...SOURCE_KEYS) as Array<{
    ticker: string;
    name: string | null;
    market: string | null;
    sources: string | null;
  }>;

  const n = replaceEdge(raw);
  const added = upsertMissingAbout(src, raw);
  src.close();

  const bySrc: Record<string, number> = {};
  for (const r of raw) {
    for (const s of (r.sources || "").split(",")) {
      if (!s) continue;
      bySrc[s] = (bySrc[s] || 0) + 1;
    }
  }
  console.log(`Synced ${n} Edge tickers from ${srcPath} → data/edge.db`);
  console.log(`Added ${added} missing tickers → data/company_about.db`);
  console.log("sources:", bySrc);
  console.log(raw.map((r) => r.ticker).join(", "));
}

main();
