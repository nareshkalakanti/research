import { fillSectorBatch } from "../src/lib/sector-fill";
import { invalidateCompanyCache, loadAllCompanies } from "../src/lib/db";

async function main() {
  const tickers = process.argv.slice(2).map((t) => t.toUpperCase());
  let remaining = loadAllCompanies().filter(
    (c) => !c.sector?.trim() || !c.sub_sector?.trim(),
  ).length;
  let totalSaved = 0;
  let round = 0;

  if (tickers.length) {
    const r = await fillSectorBatch({ tickers, limit: tickers.length });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  while (remaining > 0 && round < 40) {
    round += 1;
    const r = await fillSectorBatch({ limit: 30, concurrency: 2 });
    totalSaved += r.saved;
    remaining = r.remaining;
    console.log(`round ${round}: saved ${r.saved}, remaining ${remaining}`);
    if (r.tried === 0 || r.saved === 0) break;
  }

  invalidateCompanyCache();
  const left = loadAllCompanies().filter(
    (c) => !c.sector?.trim() || !c.sub_sector?.trim(),
  ).length;
  console.log(JSON.stringify({ totalSaved, remaining: left }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
