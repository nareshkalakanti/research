import { ingestValuepickr } from "../src/lib/valuepickr-ingest";

async function main() {
  const stats = await ingestValuepickr();
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
