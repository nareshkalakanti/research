/**
 * Solid metrics bootstrap:
 * 1) Seed price/mcap from stocks-ai stock_metrics (local, fast)
 * 2) Yahoo-fill remaining gaps (.NS → .BO)
 *
 * Usage: npx tsx scripts/fill-metrics.ts
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const METRICS_PATH = path.join(DATA, "metrics.db");
const ABOUT_PATH = path.join(DATA, "company_about.db");
const STOCKS_AI = path.join(
  ROOT,
  "..",
  "stocks-ai",
  "data",
  "stocks_ai.db",
);

function ensureMetrics() {
  const db = new Database(METRICS_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_metrics (
      ticker TEXT PRIMARY KEY,
      market TEXT,
      yf_symbol TEXT,
      price REAL,
      market_cap_cr REAL,
      sector TEXT,
      fetched_at TEXT NOT NULL
    );
  `);
  return db;
}

function seedFromStocksAi(metrics: Database.Database) {
  if (!fs.existsSync(STOCKS_AI)) {
    console.log("stocks-ai db not found — skip seed:", STOCKS_AI);
    return { seeded: 0 };
  }

  const about = new Database(ABOUT_PATH, { readonly: true });
  const tickers = new Set(
    (
      about.prepare("SELECT ticker FROM company_about").all() as {
        ticker: string;
      }[]
    ).map((r) => r.ticker.toUpperCase()),
  );
  about.close();

  const src = new Database(STOCKS_AI, { readonly: true });
  const rows = src
    .prepare(
      `SELECT ticker, market, price, market_cap_cr, sector
       FROM stock_metrics
       WHERE price IS NOT NULL OR market_cap_cr IS NOT NULL`,
    )
    .all() as Array<{
    ticker: string;
    market: string | null;
    price: number | null;
    market_cap_cr: number | null;
    sector: string | null;
  }>;
  src.close();

  const now = new Date().toISOString();
  const upsert = metrics.prepare(`
    INSERT INTO stock_metrics (ticker, market, yf_symbol, price, market_cap_cr, sector, fetched_at)
    VALUES (@ticker, @market, NULL, @price, @market_cap_cr, @sector, @fetched_at)
    ON CONFLICT(ticker) DO UPDATE SET
      market = COALESCE(excluded.market, stock_metrics.market),
      price = COALESCE(excluded.price, stock_metrics.price),
      market_cap_cr = COALESCE(excluded.market_cap_cr, stock_metrics.market_cap_cr),
      sector = COALESCE(excluded.sector, stock_metrics.sector),
      fetched_at = CASE
        WHEN excluded.price IS NOT NULL OR excluded.market_cap_cr IS NOT NULL
        THEN excluded.fetched_at ELSE stock_metrics.fetched_at END
  `);

  let seeded = 0;
  const tx = metrics.transaction(() => {
    for (const r of rows) {
      const ticker = r.ticker.toUpperCase();
      if (!tickers.has(ticker)) continue;
      upsert.run({
        ticker,
        market: r.market,
        price: r.price,
        market_cap_cr: r.market_cap_cr,
        sector: r.sector,
        fetched_at: now,
      });
      seeded += 1;
    }
  });
  tx();
  return { seeded };
}

function gapList(metrics: Database.Database) {
  const about = new Database(ABOUT_PATH, { readonly: true });
  const companies = about
    .prepare("SELECT ticker, market FROM company_about")
    .all() as Array<{ ticker: string; market: string }>;
  about.close();

  const map = new Map(
    (
      metrics
        .prepare("SELECT ticker, price, market_cap_cr FROM stock_metrics")
        .all() as Array<{
        ticker: string;
        price: number | null;
        market_cap_cr: number | null;
      }>
    ).map((r) => [r.ticker.toUpperCase(), r]),
  );

  const missing: Array<{ ticker: string; market: string }> = [];
  let missP = 0;
  let missM = 0;
  for (const c of companies) {
    const m = map.get(c.ticker.toUpperCase());
    const np = !m || m.price == null;
    const nm = !m || m.market_cap_cr == null;
    if (np) missP += 1;
    if (nm) missM += 1;
    if (np || nm) missing.push({ ticker: c.ticker, market: c.market });
  }
  return { missing, missP, missM, total: companies.length };
}

async function yahooFill(
  metrics: Database.Database,
  items: Array<{ ticker: string; market: string }>,
) {
  const { fetchQuotes } = await import("../src/lib/yfinance");
  const now = new Date().toISOString();
  const upsert = metrics.prepare(`
    INSERT INTO stock_metrics (ticker, market, yf_symbol, price, market_cap_cr, sector, fetched_at)
    VALUES (@ticker, @market, @yf_symbol, @price, @market_cap_cr, @sector, @fetched_at)
    ON CONFLICT(ticker) DO UPDATE SET
      market = COALESCE(excluded.market, stock_metrics.market),
      yf_symbol = COALESCE(excluded.yf_symbol, stock_metrics.yf_symbol),
      price = COALESCE(excluded.price, stock_metrics.price),
      market_cap_cr = COALESCE(excluded.market_cap_cr, stock_metrics.market_cap_cr),
      sector = COALESCE(excluded.sector, stock_metrics.sector),
      fetched_at = excluded.fetched_at
  `);

  const BATCH = 40;
  let filledP = 0;
  let filledM = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    process.stdout.write(
      `Yahoo ${i + 1}-${Math.min(i + BATCH, items.length)} / ${items.length}\n`,
    );
    const quotes = await fetchQuotes(chunk, { concurrency: 4 });
    const tx = metrics.transaction(() => {
      for (const q of quotes) {
        if (q.price == null && q.mcap_cr == null) continue;
        upsert.run({
          ticker: q.ticker,
          market: chunk.find((c) => c.ticker.toUpperCase() === q.ticker)
            ?.market,
          yf_symbol: q.yf_symbol,
          price: q.price,
          market_cap_cr: q.mcap_cr,
          sector: q.sector,
          fetched_at: now,
        });
        if (q.price != null) filledP += 1;
        if (q.mcap_cr != null) filledM += 1;
      }
    });
    tx();
    await new Promise((r) => setTimeout(r, 300));
  }
  return { filledP, filledM };
}

function readCsvTickers(csvPath: string): string[] {
  if (!fs.existsSync(csvPath)) return [];
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  const idx = header.indexOf("ticker");
  if (idx < 0) return [];
  return lines
    .slice(1)
    .map((l) => l.split(",")[idx]?.trim().toUpperCase())
    .filter(Boolean) as string[];
}

async function main() {
  const csvArg =
    process.argv[2] ||
    path.join(
      process.env.HOME || "",
      "Downloads/missing-metrics-NSE-2026-08-06.csv",
    );

  const metrics = ensureMetrics();
  console.log("1) Seed from stocks-ai…");
  const seed = seedFromStocksAi(metrics);
  console.log("   seeded rows:", seed.seeded);

  const { seedBseSmeMcapFromCache, fillBseSmeMetricsGaps } = await import(
    "../src/lib/metrics"
  );
  const bseSeed = seedBseSmeMcapFromCache();
  console.log("1b) Seed BSE SME mcap from BSE cache…", bseSeed);

  let gaps = gapList(metrics);
  console.log("2) Gaps after seed:", {
    total: gaps.total,
    missPrice: gaps.missP,
    missMcap: gaps.missM,
    either: gaps.missing.length,
  });

  const csvTickers = new Set(readCsvTickers(csvArg));
  if (csvTickers.size) {
    console.log("3) CSV priority tickers:", [...csvTickers].join(", "));
  }

  // Prioritize CSV tickers still missing, then the rest
  const prioritized = [
    ...gaps.missing.filter((m) => csvTickers.has(m.ticker.toUpperCase())),
    ...gaps.missing.filter((m) => !csvTickers.has(m.ticker.toUpperCase())),
  ];

  if (prioritized.length) {
    console.log(`4) Yahoo-fill ${prioritized.length} remaining…`);
    const yf = await yahooFill(metrics, prioritized);
    console.log("   yahoo filled:", yf);
  } else {
    console.log("4) Nothing left for Yahoo");
  }

  const bsePending = gapList(metrics).missing.filter(
    (m) => m.market === "BSE SME",
  );
  if (bsePending.length) {
    console.log(`4b) BSE API fill ${bsePending.length} BSE SME gaps…`);
    const bse = await fillBseSmeMetricsGaps(bsePending);
    console.log("   bse filled:", bse);
  }

  gaps = gapList(metrics);
  console.log("5) Final coverage:", {
    total: gaps.total,
    withPrice: gaps.total - gaps.missP,
    withMcap: gaps.total - gaps.missM,
    missPrice: gaps.missP,
    missMcap: gaps.missM,
  });

  // Show CSV results
  if (csvTickers.size) {
    const get = metrics.prepare(
      "SELECT ticker, price, market_cap_cr FROM stock_metrics WHERE ticker = ?",
    );
    console.log("6) CSV tickers:");
    for (const t of csvTickers) {
      console.log("  ", get.get(t));
    }
  }

  metrics.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
