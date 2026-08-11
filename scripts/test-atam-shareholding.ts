import { fetchShareholdingHits } from "../src/lib/smart-money/shareholding";
import { fetchInvestorNewsSignals } from "../src/lib/smart-money/news";

async function main() {
  console.log("ATAM shareholding…");
  const sh = await fetchShareholdingHits("ATAM");
  console.log(JSON.stringify(sh, null, 2));

  console.log("\nNews…");
  const news = await fetchInvestorNewsSignals();
  console.log("Count:", news.length);
  for (const n of news.slice(0, 8)) {
    console.log("-", n.investor_ids.join(","), n.headline.slice(0, 80));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
