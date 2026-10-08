import { discoverConcallPdfSources } from "../src/lib/concall-screen";
import { discoverInvestorMaterialSources } from "../src/lib/investor-material-scrape";
import { searchGrowwListings } from "../src/lib/web-mcap";
import { resolveBseScripCode } from "../src/lib/bse-investor-discover";

async function main() {
  const q = "STEAMHOUSE";
  const groww = await searchGrowwListings(q, 5);
  console.log("groww", groww);
  console.log("cached scrip", resolveBseScripCode(q, null));
  const found = await discoverInvestorMaterialSources(q, { refresh: true });
  console.log("discover note", found.note);
  console.log("sources", found.sources.length);
  for (const s of found.sources.slice(0, 20)) {
    console.log({
      kind: s.kind,
      provider: s.provider,
      period: s.period,
      title: s.title.slice(0, 80),
      url: s.url.slice(0, 120),
    });
  }
  const pdf = await discoverConcallPdfSources(q);
  console.log("pdf hits", pdf.sources.length, "note", pdf.note);
  console.log("latest tx", pdf.latest_transcript);
  console.log("latest ppt", pdf.latest_ppt);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
