import Database from "better-sqlite3";
import { fetchQuoteDetailed } from "../src/lib/yfinance";

/** Listed shares — Yahoo omits marketCap for VISDEM-SM.NS; derive from LTP. */
const VISDEM_SHARES = 10_272_093;

function deriveMcapCr(price: number): number {
  return Math.round(((price * VISDEM_SHARES) / 1e7) * 10) / 10;
}

async function main() {
  const q = await fetchQuoteDetailed("VISDEM", "NSE SME");
  console.log("yahoo", q);

  if (q.price == null) {
    console.log("no yahoo price for VISDEM");
    return;
  }

  const mcap_cr = q.mcap_cr ?? deriveMcapCr(q.price);
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
    mcap: mcap_cr,
    sector: q.sector,
    at: new Date().toISOString(),
  });
  db.close();
  console.log("saved", { price: q.price, mcap_cr });
}

main();
