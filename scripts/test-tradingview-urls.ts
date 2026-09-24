/**
 * Gold checks for TradingView / BSE chart URLs (test/tradingview-urls.json).
 */
import fs from "fs";
import path from "path";
import { tradingviewUrl } from "../src/lib/links";

const GOLD = path.join(process.cwd(), "test", "tradingview-urls.json");

type Case = {
  ticker: string;
  market: string | null;
  url: string;
  note?: string;
};

function main() {
  const cases = JSON.parse(fs.readFileSync(GOLD, "utf8")) as Case[];
  let failed = 0;
  for (const c of cases) {
    const got = tradingviewUrl(c.ticker, c.market);
    if (got !== c.url) {
      failed += 1;
      console.error(`FAIL ${c.ticker} market=${c.market}\n  want ${c.url}\n  got  ${got}`);
    } else {
      console.log(`ok ${c.ticker} ${c.market ?? "(lookup)"}`);
    }
  }
  if (failed) {
    process.exit(1);
  }
}

main();
