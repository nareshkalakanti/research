/**
 * LLM-clean raw website scrapes → scraped_about_clean.
 * Skips already-cleaned and already-attempted rows; runs pending in parallel.
 *
 *   npx tsx scripts/clean-scraped-about.ts
 *   npx tsx scripts/clean-scraped-about.ts --concurrency 12
 *   npx tsx scripts/clean-scraped-about.ts --limit 40
 *   npx tsx scripts/clean-scraped-about.ts --dry-run --limit 20
 *   npx tsx scripts/clean-scraped-about.ts --ticker GLAND --force
 *   npx tsx scripts/clean-scraped-about.ts --market "NSE SME"
 *   npx tsx scripts/clean-scraped-about.ts --force   # redo cleaned + rejected
 */
import fs from "fs";
import path from "path";
import { loadLlmConfig } from "../src/lib/llm-config";
import { checkLlmStatus } from "../src/lib/llm-client";
import {
  CLEAN_CLI_CONCURRENCY_DEFAULT,
  CLEAN_CLI_CONCURRENCY_MAX,
  loadScrapeCleanInventory,
  runScrapeCleanQueue,
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

function argValue(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  return i >= 0 ? String(args[i + 1] || "").trim() : "";
}

function parseArgs() {
  const args = process.argv.slice(2);
  const concurrencyRaw = Number(argValue(args, "--concurrency") || argValue(args, "-c"));
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    limit: (() => {
      const n = Number(argValue(args, "--limit"));
      return n > 0 ? Math.floor(n) : 0;
    })(),
    ticker: argValue(args, "--ticker").toUpperCase(),
    market: argValue(args, "--market") || "All",
    concurrency: Number.isFinite(concurrencyRaw) && concurrencyRaw > 0
      ? Math.min(CLEAN_CLI_CONCURRENCY_MAX, Math.max(1, Math.floor(concurrencyRaw)))
      : CLEAN_CLI_CONCURRENCY_DEFAULT,
  };
}

function rowStatus(result: ScrapeCleanRowProgress["result"]): string {
  if (!result) return "error";
  if (result.passed) return "ok";
  return result.reason;
}

async function main() {
  loadEnvLocal();
  const { dryRun, force, limit, ticker, market, concurrency } = parseArgs();

  const cfg = loadLlmConfig();
  const status = await checkLlmStatus(cfg);
  if (!status.available) {
    console.error(`LLM unavailable: ${status.detail}`);
    console.error(status.hint);
    process.exit(1);
  }
  console.log(`LLM: ${status.detail}`);
  console.log(
    `Workers: ${concurrency} parallel` +
      (dryRun ? " · dry-run" : "") +
      (force ? " · force (redo done)" : ""),
  );

  const inv = loadScrapeCleanInventory({
    market,
    tickers: ticker ? [ticker] : undefined,
    force,
  });
  console.log(
    `Inventory (${market}): ${inv.withRaw.toLocaleString()} with scrape · ` +
      `${inv.alreadyClean.toLocaleString()} cleaned · ` +
      `${inv.alreadyAttempted.toLocaleString()} already attempted · ` +
      `${inv.pending.length.toLocaleString()} pending`,
  );

  if (!inv.pending.length) {
    console.log(
      force
        ? "Nothing to clean."
        : "Nothing pending — already cleaned or attempted. Use --force to redo.",
    );
    return;
  }

  const target = limit > 0 ? Math.min(limit, inv.pending.length) : inv.pending.length;
  console.log(`Running ${target.toLocaleString()} of ${inv.pending.length.toLocaleString()} pending…`);

  const started = Date.now();
  let done = 0;
  const result = await runScrapeCleanQueue({
    market,
    tickers: ticker ? [ticker] : undefined,
    limit: limit > 0 ? limit : undefined,
    force,
    dryRun,
    concurrency,
    onProgress: (p) => {
      done += 1;
      const elapsed = Math.max(1, (Date.now() - started) / 1000);
      const rate = (done / elapsed).toFixed(2);
      const left = target - done;
      const eta = left > 0 ? Math.round(left / Math.max(done / elapsed, 0.01)) : 0;
      console.log(
        `  [${done}/${target}] ${p.ticker} ${rowStatus(p.result)} · ${rate}/s · eta ${eta}s`,
      );
    },
  });

  const sec = Math.round((Date.now() - started) / 1000);
  console.log(
    `\nDone in ${sec}s — pass ${result.saved} · reject ${result.rejected} · errors ${result.failed} · ${result.remaining.toLocaleString()} remaining`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
