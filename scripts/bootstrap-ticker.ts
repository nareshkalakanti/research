import Database from "better-sqlite3";
import { bootstrapCompanyTicker } from "../src/lib/company-ticker-bootstrap";

async function main() {
  const ticker = (process.argv[2] || "").trim().toUpperCase();
  if (!ticker) {
    console.error("Usage: tsx scripts/bootstrap-ticker.ts TICKER");
    process.exit(1);
  }

  const ok = await bootstrapCompanyTicker(ticker);
  console.log("bootstrap:", ok);

  const db = new Database("./data/company_about.db", { readonly: true });
  const row = db
    .prepare("SELECT ticker, name, market FROM company_about WHERE ticker = ?")
    .get(ticker);
  console.log("about:", row);
  db.close();

  const mdb = new Database("./data/metrics.db", { readonly: true });
  const m = mdb
    .prepare(
      "SELECT ticker, price, market_cap_cr, sector FROM stock_metrics WHERE ticker = ?",
    )
    .get(ticker);
  console.log("metrics:", m);
  mdb.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
