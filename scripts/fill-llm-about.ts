/**
 * Write LLM About for names with no Yahoo/Screener about (no website scrape).
 *
 *   npx tsx scripts/fill-llm-about.ts
 *   npx tsx scripts/fill-llm-about.ts --limit 20
 *   npx tsx scripts/fill-llm-about.ts --ticker RADIOWALLAH
 *   npx tsx scripts/fill-llm-about.ts --market "NSE SME"
 */
import fs from "fs";
import path from "path";
import { fillLlmAboutBatch, llmAboutCandidates } from "../src/lib/llm-about";

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

async function main() {
  loadEnvLocal();
  const args = parseArgs();
  const tickers = args.ticker ? [args.ticker] : undefined;
  let remaining = llmAboutCandidates({ market: args.market, tickers }).length;
  let totalSaved = 0;
  let round = 0;
  const cap = args.limit || remaining;
  console.log(`pending ${remaining} · filling up to ${cap}`);

  while (remaining > 0 && totalSaved < cap && round < 80) {
    round += 1;
    const r = await fillLlmAboutBatch({
      market: args.market,
      tickers,
      limit: Math.min(12, cap - totalSaved),
      concurrency: 2,
    });
    totalSaved += r.saved;
    remaining = r.remaining;
    console.log(
      `round ${round}: saved ${r.saved} failed ${r.failed} remaining ${remaining}`,
    );
    if (r.tried === 0 || r.saved === 0) break;
  }
  console.log(JSON.stringify({ totalSaved, remaining }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
