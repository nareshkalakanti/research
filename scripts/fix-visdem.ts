import Database from "better-sqlite3";
import { fetchQuoteDetailed } from "../src/lib/yfinance";

async function main() {
  for (const market of ["NSE SME", "NSE"] as const) {
    const q = await fetchQuoteDetailed("VISDEM", market);
    console.log(market, q);
    if (q.price != null || q.mcap_cr != null) {
      const db = new Database("data/metrics.db");
      db.prepare(
        `INSERT INTO stock_metrics (ticker, market, yf_symbol, price, market_cap_cr, sector, fetched_at)
         VALUES (@ticker, @market, @yf_symbol, @price, @mcap, @sector, @at)
         ON CONFLICT(ticker) DO UPDATE SET
           price = COALESCE(excluded.price, stock_metrics.price),
           market_cap_cr = COALESCE(excluded.market_cap_cr, stock_metrics.market_cap_cr),
           yf_symbol = COALESCE(excluded.yf_symbol, stock_metrics.yf_symbol),
           fetched_at = excluded.fetched_at`,
      ).run({
        ticker: "VISDEM",
        market: "NSE SME",
        yf_symbol: q.yf_symbol,
        price: q.price,
        mcap: q.mcap_cr,
        sector: q.sector,
        at: new Date().toISOString(),
      });
      db.close();
      console.log("saved");
      return;
    }
  }
  console.log("no yahoo data for VISDEM");
}

main();
