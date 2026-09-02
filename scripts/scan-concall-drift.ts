/**
 * Pull NSE-announced earn/concall names (default) or backfill the whole universe.
 * npm run scan:concall-drift
 * npm run scan:concall-drift -- --all
 */
import { runConcallDriftScanBatch } from "../src/lib/strategy/concall-drift-scan";

const BATCH = 32;
const CONCURRENCY = 6;
const PAUSE_MS = 300;
const ALL = process.argv.includes("--all");

async function main() {
  let round = 0;
  let totalFail = 0;
  const t0 = Date.now();
  let leftover: string[] | undefined;

  for (;;) {
    round += 1;
    const result = await runConcallDriftScanBatch({
      market: "All",
      limit: BATCH,
      concurrency: CONCURRENCY,
      announced: ALL ? false : leftover == null,
      announcedDays: 7,
      tickers: leftover,
    });
    leftover = result.remaining_tickers?.length
      ? result.remaining_tickers
      : undefined;
    totalFail += result.failed;

    const pct =
      result.universe > 0
        ? Math.round((100 * result.scanned) / result.universe)
        : 0;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(
      `[${round}] ${result.scanned}/${result.universe} (${pct}%) · ${result.remaining} left · +${result.saved} ok${result.failed ? ` · ${result.failed} err` : ""} · ${CONCURRENCY} workers · ${elapsed}s`,
    );

    if (result.tried === 0 || result.done || result.remaining <= 0) {
      console.log(
        `Done · ${result.scanned} scanned · ${totalFail} failed · ${Math.round(elapsed / 60)} min`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
