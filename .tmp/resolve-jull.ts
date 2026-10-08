import { resolveListingQuery } from "../src/lib/sector-rotation-resolve";
import { loadAllCompanies } from "../src/lib/db";
import { listingQueryMatches, rankListingQuery } from "../src/lib/listing-name-match";

async function main() {
  const local = loadAllCompanies().filter(
    (c) =>
      /jullundur|jma/i.test(c.ticker + c.name) ||
      listingQueryMatches(
        "Jullundur Motor Agency (Delhi) Ltd",
        c.ticker,
        c.name,
      ),
  );
  console.log(
    "local",
    local.map((c) => ({ t: c.ticker, n: c.name, m: c.market })),
  );
  const qs = [
    "Jullundur Motor Agency (Delhi) Ltd",
    "Jullundur Motor Agency (Delhi) Limited",
    "Jullundur Motor Agency",
  ];
  for (const q of qs) {
    const h = await resolveListingQuery(q);
    console.log("resolve", q, h);
  }
}

void main();
