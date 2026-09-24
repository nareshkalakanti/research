/**
 * Insert a missing listed ticker into company_about from exchange / Yahoo / Tickertape.
 * Usage: npx tsx scripts/bootstrap-ticker.ts TICKER [name…] [NSE|BSE|NSE SME|BSE SME]
 */
import { bootstrapCompanyTicker } from "../src/lib/company-ticker-bootstrap";

const args = process.argv.slice(2);
if (!args.length) {
  console.error(
    "Usage: npx tsx scripts/bootstrap-ticker.ts TICKER [name…] [NSE|BSE|NSE SME|BSE SME]",
  );
  process.exit(1);
}

const MARKET_RE = /^(NSE|BSE|NSE SME|BSE SME)$/i;
let market: string | null = null;
if (args.length > 1 && MARKET_RE.test(args[args.length - 1]!)) {
  market = args.pop()!.toUpperCase().replace(/\s+/g, " ");
  if (market === "BSE SME" || market === "NSE SME") {
    /* keep */
  } else if (market === "BSE" || market === "NSE") {
    /* keep */
  }
}

const ticker = (args[0] || "").trim();
const name = args.slice(1).join(" ").trim();

void bootstrapCompanyTicker(ticker, {
  name: name || null,
  market,
}).then((ok) => {
  console.log(
    JSON.stringify({
      ticker: ticker.toUpperCase(),
      name: name || null,
      market,
      bootstrapped: ok,
    }),
  );
  process.exit(ok ? 0 : 2);
});
