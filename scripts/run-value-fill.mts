/**
 * Fill missing Sales 3Y / ROCE 3Y on the Value universe.
 *
 * Priority: never_fetched → gaps → ht_failed (skips short_history).
 * Sources: Upstox → IndianAPI → Yahoo (yfinance) → Screener.
 *
 * Usage:
 *   npm run fill:value-legs
 *   npm run fill:value-legs -- --status
 *   npm run fill:value-legs -- --loops 20 --pages 50
 *
 * Load UPSTOX_ACCESS_TOKEN + STOCK_PRICE_API_KEY from .env.local when present.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      if (process.env[m[1]!] == null || process.env[m[1]!] === "") {
        process.env[m[1]!] = m[2]!;
      }
    }
  } catch {
    /* optional */
  }
}

function argNum(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

loadEnvLocal();

function log(obj: unknown) {
  const line = typeof obj === "string" ? obj : JSON.stringify(obj);
  process.stdout.write(line + "\n");
}

const statusOnly = process.argv.includes("--status");
const loops = argNum("--loops", 3);
const pages = argNum("--pages", 25);
const upstoxLimit = argNum("--upstox", 120);
const indianLimit = argNum("--indian", 100);
const yahooLimit = argNum("--yahoo", 80);

const { classifySalesRoceGaps, fillMissingSalesRoce, stopValueFill } = await import(
  "../src/lib/value-tools.ts"
);
const { upstoxConfigured } = await import("../src/lib/upstox-fundamentals.ts");
const { indianApiConfigured } = await import("../src/lib/indianapi-fundamentals.ts");
const { screenerPausedUntil } = await import("../src/lib/screener-fetch.ts");

function snapshot() {
  const { counts, fixable, gaps } = classifySalesRoceGaps({ includePortfolio: true });
  return {
    missing: gaps.length,
    fixable: fixable.length,
    counts,
    upstox: upstoxConfigured(),
    indianapi: indianApiConfigured(),
    screener_paused_until: screenerPausedUntil(),
    at: new Date().toISOString(),
  };
}

log(JSON.stringify({ phase: "start", ...snapshot() }, null, 2));

if (statusOnly) process.exit(0);

process.on("SIGINT", () => {
  log({ phase: "stopping" });
  stopValueFill();
});
process.on("uncaughtException", (e) => {
  log({ phase: "uncaughtException", error: String(e) });
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  log({ phase: "unhandledRejection", error: String(e) });
  process.exit(1);
});

let last = {
  tried: 0,
  filled: 0,
  left: 0,
  not_found: 0,
  screener: 0,
  upstox: 0,
  indianapi: 0,
  yahoo: 0,
};
for (let i = 1; i <= loops; i++) {
  const paused = screenerPausedUntil();
  if (paused) {
    log({ phase: "paused", until: paused, loop: i });
    break;
  }
  const before = classifySalesRoceGaps().fixable.length;
  if (before === 0) {
    log({ phase: "done", loop: i, fixable: 0 });
    break;
  }
  log({
    phase: "loop",
    loop: i,
    of: loops,
    fixable: before,
    pages,
    upstoxLimit,
    indianLimit,
    yahooLimit,
  });
  try {
    last = await fillMissingSalesRoce(
      (done, total, filled) => {
        if (done === 0 || done === total || done % 5 === 0) {
          log({ loop: i, done, total, filled, at: new Date().toISOString() });
        }
      },
      { pageLimit: pages, upstoxLimit, indianLimit, yahooLimit },
    );
    log({ phase: "loop_done", loop: i, ...last });
  } catch (e) {
    log({ phase: "ERR", error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
  if (last.screener === 0 && last.upstox === 0 && last.indianapi === 0 && last.yahoo === 0) {
    log({ phase: "idle", reason: "no work this pass (retry windows)", loop: i });
    break;
  }
}

log(JSON.stringify({ phase: "end", last, ...snapshot() }, null, 2));
