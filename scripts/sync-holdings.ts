/**
 * Import personal holdings from data/holdings.json into data/holdings.db.
 *
 *   npm run sync:holdings
 *
 * JSON shape: [{ "ticker": "RELIANCE", "name": "...", "market": "NSE", "sector": null, "sub_sector": null }]
 */
import fs from "fs";
import path from "path";
import { replaceHoldings } from "../src/lib/holdings";
import { resolveTickerMeta } from "./lib/local-ticker-meta";

const JSON_PATH = path.join(process.cwd(), "data", "holdings.json");

type HoldingJson = {
  ticker: string;
  name?: string | null;
  market?: string | null;
  sector?: string | null;
  sub_sector?: string | null;
};

function main() {
  if (!fs.existsSync(JSON_PATH)) {
    console.error(
      `Missing ${JSON_PATH}\n` +
        "Holdings live in data/holdings.db — export/edit that file or add holdings.json to import.",
    );
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(JSON_PATH, "utf8")) as HoldingJson[];
  const rows = raw.map((r) => {
    const meta = resolveTickerMeta(r.ticker);
    return {
      ticker: meta.ticker,
      name: r.name?.trim() || meta.name,
      market: (r.market || meta.market).toUpperCase(),
      sector: r.sector?.trim() || meta.sector,
      sub_sector: r.sub_sector?.trim() || meta.industry,
    };
  });

  const n = replaceHoldings(rows);
  console.log(`Synced ${n} holdings from ${JSON_PATH} → data/holdings.db`);
  console.log(rows.map((r) => r.ticker).join(", "));
}

main();
