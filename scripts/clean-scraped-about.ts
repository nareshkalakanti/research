/**
 * LLM-clean raw website scrapes → scraped_about_clean (CLI).
 *
 *   npx tsx scripts/clean-scraped-about.ts
 *   npx tsx scripts/clean-scraped-about.ts --limit 20
 *   npx tsx scripts/clean-scraped-about.ts --dry-run --limit 20
 *   npx tsx scripts/clean-scraped-about.ts --ticker GLAND --force
 *   npx tsx scripts/clean-scraped-about.ts --market NSE
 */
import fs from "fs";
import path from "path";
import { loadLlmConfig } from "../src/lib/llm-config";
import { checkLlmStatus } from "../src/lib/llm-client";
import {
  CLEAN_SESSION_MAX_ITEMS,
  pendingScrapeCleanCount,
  runScrapeCleanBatch,
  runScrapeCleanSession,
  type ScrapeCleanRowProgress,
} from "../src/lib/scrape-clean-batch";

function loadEnvLocal(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    limit: (() => {
      const i = args.indexOf("--limit");
      return i >= 0 ? Math.max(1, Number(args[i + 1]) || 0) : 0;
    })(),
    ticker: (() => {
      const i = args.indexOf("--ticker");
      return i >= 0 ? String(args[i + 1] || "").trim().toUpperCase() : "";
    })(),
    market: (() => {
      const i = args.indexOf("--market");
      return i >= 0 ? String(args[i + 1] || "All") : "All";
    })(),
  };
}

function rowStatus(result: ScrapeCleanRowProgress["result"]): string {
  if (!result) return "error";
  if (result.passed) return "ok";
  return result.reason;
}

function makeProgressLogger(opts: {
  chunkStart: number;
  chunkTarget: number;
  getDoneInChunk: () => number;
  bumpDoneInChunk: () => void;
}) {
  return (p: ScrapeCleanRowProgress) => {
    opts.bumpDoneInChunk();
    const done = opts.getDoneInChunk();
    const elapsed = Math.round((Date.now() - opts.chunkStart) / 1000);
    console.log(
      `  [${done}/${opts.chunkTarget}] ${p.ticker} ${rowStatus(p.result)} · ${elapsed}s`,
    );
  };
}

async function main() {
  loadEnvLocal();
  const { dryRun, force, limit, ticker, market } = parseArgs();

  const cfg = loadLlmConfig();
  const status = await checkLlmStatus(cfg);
  if (!status.available) {
    console.error(`LLM unavailable: ${status.detail}`);
    console.error(status.hint);
    process.exit(1);
  }
  console.log(`LLM: ${status.detail}`);

  if (ticker) {
    console.log(`Cleaning ${ticker}…`);
    const one = await runScrapeCleanBatch({
      tickers: [ticker],
      limit: 1,
      force,
      dryRun,
      onProgress: (p) => {
        console.log(`  ${p.ticker} ${rowStatus(p.result)}`);
      },
    });
    console.log(one);
    return;
  }

  let remaining = pendingScrapeCleanCount(market);
  if (remaining === 0) {
    console.log(`Nothing to clean (${market}).`);
    return;
  }

  console.log(`${remaining.toLocaleString()} pending (${market})`);

  let totalSaved = 0;
  let totalRejected = 0;
  let totalFailed = 0;
  let chunks = 0;

  while (remaining > 0) {
    chunks += 1;
    const chunkTarget = limit > 0 ? limit : Math.min(remaining, CLEAN_SESSION_MAX_ITEMS);
    const chunkStart = Date.now();
    let doneInChunk = 0;

    console.log(
      `\nchunk ${chunks}: up to ${chunkTarget.toLocaleString()} rows · ${remaining.toLocaleString()} in queue`,
    );

    const onProgress = makeProgressLogger({
      chunkStart,
      chunkTarget,
      getDoneInChunk: () => doneInChunk,
      bumpDoneInChunk: () => {
        doneInChunk += 1;
      },
    });

    const batch =
      limit > 0
        ? await runScrapeCleanBatch({
            market,
            limit,
            force,
            dryRun,
            onProgress,
          })
        : await runScrapeCleanSession({
            market,
            force,
            dryRun,
            onProgress,
            onBatchDone: (inner) => {
              if (inner.tried === 0) return;
              console.log(
                `  batch done: +${inner.saved} cleaned · ${inner.rejected} rejected · ${inner.failed} errors · ${inner.remaining.toLocaleString()} left`,
              );
            },
          });

    if (batch.tried === 0) break;

    totalSaved += batch.saved;
    totalRejected += batch.rejected;
    totalFailed += batch.failed;
    remaining = batch.remaining;

    const chunkSec = Math.round((Date.now() - chunkStart) / 1000);
    console.log(
      `chunk ${chunks} done (${chunkSec}s): +${batch.saved} cleaned · ${batch.rejected} rejected · ${batch.failed} errors · ${remaining.toLocaleString()} left`,
    );

    if (limit > 0) break;
    if (batch.done) break;
  }

  console.log(
    `\nDone — pass ${totalSaved} · reject ${totalRejected} · errors ${totalFailed} · ${remaining.toLocaleString()} remaining`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
