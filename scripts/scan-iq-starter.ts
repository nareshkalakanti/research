/**
 * Analyse until starter investment thresholds are met (then stop).
 *
 * Targets (enough to start using the IQ tabs):
 *   OrderBook  ≥ 20 PASS   (or pending queue empty)
 *   BoardRoom  ≥ 200 analysed
 *   MarketIQ   ≥ 500 analysed
 *
 *   npm run scan:iq-starter
 *   npm run scan:iq-starter -- --lane boardroom
 */
import { spawnSync } from "child_process";
import path from "path";
import { openSqliteNamed } from "../src/lib/sqlite-utils";
import { marketIqDbFile, orderBookIqDbFile, boardRoomIqDbFile } from "../src/lib/iq-dbs";

type Lane = "orderbook" | "boardroom" | "marketiq";

const TARGETS = {
  orderbookPass: 20,
  boardroomAnalysed: 200,
  marketiqAnalysed: 500,
} as const;

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function counts() {
  const ob = openSqliteNamed(orderBookIqDbFile(), { readonly: true, wal: true });
  let orderbookPass = 0;
  let orderbookPending = 0;
  try {
    orderbookPending = (
      ob
        .prepare(
          `SELECT COUNT(*) AS c FROM orderbook_screens WHERE engine = 'exchange-fetch'`,
        )
        .get() as { c: number }
    ).c;
    orderbookPass = (
      ob
        .prepare(
          `SELECT COUNT(*) AS c FROM orderbook_screens
           WHERE engine != 'exchange-fetch'
             AND extract_json LIKE '%"_decision":"pass"%'`,
        )
        .get() as { c: number }
    ).c;
  } finally {
    ob.close();
  }

  const mi = openSqliteNamed(marketIqDbFile(), { readonly: true, wal: true });
  let marketiqAnalysed = 0;
  let marketiqPending = 0;
  try {
    marketiqAnalysed = (
      mi
        .prepare(
          `SELECT COUNT(*) AS c FROM announcement_screens
           WHERE lower(COALESCE(sentiment, 'pending')) != 'pending'
             AND COALESCE(engine, '') != 'nse-came-fetch'`,
        )
        .get() as { c: number }
    ).c;
    marketiqPending = (
      mi
        .prepare(
          `SELECT COUNT(*) AS c FROM announcement_screens
           WHERE lower(COALESCE(sentiment, 'pending')) = 'pending'
              OR engine = 'nse-came-fetch'`,
        )
        .get() as { c: number }
    ).c;
  } finally {
    mi.close();
  }

  const br = openSqliteNamed(boardRoomIqDbFile(), { readonly: true, wal: true });
  let boardroomAnalysed = 0;
  let boardroomPending = 0;
  try {
    boardroomAnalysed = (
      br
        .prepare(
          `SELECT COUNT(*) AS c FROM boardroom_screens
           WHERE lower(COALESCE(status, 'pending')) != 'pending'
             AND COALESCE(engine, '') != 'nse-came-fetch'`,
        )
        .get() as { c: number }
    ).c;
    boardroomPending = (
      br
        .prepare(
          `SELECT COUNT(*) AS c FROM boardroom_screens
           WHERE lower(COALESCE(status, 'pending')) = 'pending'
              OR engine = 'nse-came-fetch'`,
        )
        .get() as { c: number }
    ).c;
  } finally {
    br.close();
  }

  return {
    orderbookPass,
    orderbookPending,
    marketiqAnalysed,
    marketiqPending,
    boardroomAnalysed,
    boardroomPending,
  };
}

function runLane(script: string, limit: number, extra: string[] = []): number {
  const args = [
    path.join("scripts", script),
    "--pending-only",
    "--limit",
    String(limit),
    "--batch",
    "3",
    "--pause-ms",
    "300",
    ...extra,
  ];
  console.log(`\n→ npx tsx ${args.join(" ")}`);
  const r = spawnSync("npx", ["tsx", ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
  return r.status ?? 1;
}

function parseLanes(): Lane[] {
  const raw = (argValue("--lane") || "all").toLowerCase();
  if (raw === "all") return ["orderbook", "boardroom", "marketiq"];
  if (raw === "orderbook" || raw === "boardroom" || raw === "marketiq") {
    return [raw];
  }
  throw new Error(`Unknown --lane ${raw}`);
}

function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`Usage:
  npm run scan:iq-starter
  npm run scan:iq-starter -- --lane boardroom
  npm run scan:iq-starter -- --status

Starter targets:
  OrderBook  ≥ ${TARGETS.orderbookPass} PASS (or no pending left)
  BoardRoom  ≥ ${TARGETS.boardroomAnalysed} analysed
  MarketIQ   ≥ ${TARGETS.marketiqAnalysed} analysed`);
    return;
  }

  const c0 = counts();
  console.log("Current:", c0);
  console.log("Targets:", TARGETS);

  if (hasFlag("--status")) return;

  const lanes = parseLanes();

  for (const lane of lanes) {
    const c = counts();
    if (lane === "orderbook") {
      if (
        c.orderbookPass >= TARGETS.orderbookPass ||
        c.orderbookPending === 0
      ) {
        console.log(
          `\n✓ OrderBook starter met (PASS ${c.orderbookPass}, pending ${c.orderbookPending})`,
        );
        continue;
      }
      const need = Math.min(80, Math.max(20, c.orderbookPending));
      const code = runLane("scan-orderbook-bg.ts", need, ["--mode", "lexical"]);
      if (code !== 0) process.exit(code);
    } else if (lane === "boardroom") {
      if (c.boardroomAnalysed >= TARGETS.boardroomAnalysed) {
        console.log(
          `\n✓ BoardRoom starter met (analysed ${c.boardroomAnalysed})`,
        );
        continue;
      }
      const need = Math.min(
        160,
        Math.max(40, TARGETS.boardroomAnalysed - c.boardroomAnalysed),
      );
      const code = runLane("scan-boardroom-bg.ts", need);
      if (code !== 0) process.exit(code);
    } else {
      if (c.marketiqAnalysed >= TARGETS.marketiqAnalysed) {
        console.log(
          `\n✓ MarketIQ starter met (analysed ${c.marketiqAnalysed})`,
        );
        continue;
      }
      const need = Math.min(
        200,
        Math.max(40, TARGETS.marketiqAnalysed - c.marketiqAnalysed),
      );
      const code = runLane("scan-marketiq-bg.ts", need);
      if (code !== 0) process.exit(code);
    }
  }

  const done = counts();
  console.log("\n=== Starter status ===");
  console.log(
    `OrderBook  PASS ${done.orderbookPass}/${TARGETS.orderbookPass} (pending ${done.orderbookPending})`,
  );
  console.log(
    `BoardRoom  analysed ${done.boardroomAnalysed}/${TARGETS.boardroomAnalysed} (pending ${done.boardroomPending})`,
  );
  console.log(
    `MarketIQ   analysed ${done.marketiqAnalysed}/${TARGETS.marketiqAnalysed} (pending ${done.marketiqPending})`,
  );

  const ok =
    (done.orderbookPass >= TARGETS.orderbookPass ||
      done.orderbookPending === 0) &&
    done.boardroomAnalysed >= TARGETS.boardroomAnalysed &&
    done.marketiqAnalysed >= TARGETS.marketiqAnalysed;
  if (ok) {
    console.log("\nStarter thresholds met — you can use the IQ tabs for decisions.");
  } else {
    console.log("\nRe-run npm run scan:iq-starter to continue toward targets.");
  }
}

main();
