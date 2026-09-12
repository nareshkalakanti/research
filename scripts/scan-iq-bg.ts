/**
 * Run pending PDF analysis for MarketIQ + OrderBook + BoardRoom (resume-safe).
 *
 *   npm run scan:iq-bg -- --limit 40
 *   npm run scan:iq-bg -- --lane marketiq --limit 40
 */
import { spawnSync } from "child_process";
import path from "path";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const lane = (argValue("--lane") || "all").toLowerCase();
const limit = argValue("--limit") || "40";
const batch = argValue("--batch") || "3";
const pause = argValue("--pause-ms") || "300";
const ocr = hasFlag("--ocr");

const scripts: { name: string; file: string }[] = [];
if (lane === "all" || lane === "marketiq") {
  scripts.push({ name: "marketiq", file: "scan-marketiq-bg.ts" });
}
if (lane === "all" || lane === "orderbook") {
  scripts.push({ name: "orderbook", file: "scan-orderbook-bg.ts" });
}
if (lane === "all" || lane === "boardroom") {
  scripts.push({ name: "boardroom", file: "scan-boardroom-bg.ts" });
}

if (!scripts.length || hasFlag("--help") || hasFlag("-h")) {
  console.log(`Usage:
  npm run scan:iq-bg -- --limit 40
  npm run scan:iq-bg -- --lane marketiq --limit 40
  npm run scan:iq-bg -- --lane orderbook --ocr --limit 30
  npm run scan:iq-bg -- --lane boardroom --limit 40`);
  process.exit(scripts.length ? 0 : 1);
}

for (const s of scripts) {
  const args = [
    path.join("scripts", s.file),
    "--pending-only",
    "--limit",
    limit,
    "--batch",
    batch,
    "--pause-ms",
    pause,
  ];
  if (ocr && s.name === "orderbook") args.push("--ocr");
  if (ocr && s.name === "marketiq") args.push("--ocr");
  console.log(`\n=== ${s.name} ===`);
  const r = spawnSync("npx", ["tsx", ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
  if (r.status && r.status !== 0) {
    console.error(`${s.name} exited ${r.status} — re-run to resume`);
    process.exit(r.status);
  }
}

console.log("\nAll lanes finished (or empty queues).");
