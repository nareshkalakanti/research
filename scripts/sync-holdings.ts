/**
 * Copy personal holdings from sibling stocks-ai into data/holdings.db.
 *
 *   npx tsx scripts/sync-holdings.ts
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { replaceHoldings } from "../src/lib/holdings";

const CANDIDATES = [
  path.join(process.cwd(), "..", "stocks-ai", "data", "stocks_ai.db"),
  path.join(
    process.env.HOME || "",
    "Development/ai.com/stocks-ai/data/stocks_ai.db",
  ),
];

function findSource(): string {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `stocks_ai.db not found. Tried:\n${CANDIDATES.map((p) => `  ${p}`).join("\n")}`,
  );
}

function main() {
  const srcPath = findSource();
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  const rows = src
    .prepare(
      `SELECT ticker, name, market, sector, sub_sector FROM holdings ORDER BY ticker`,
    )
    .all() as Array<{
    ticker: string;
    name: string | null;
    market: string | null;
    sector: string | null;
    sub_sector: string | null;
  }>;
  src.close();

  const n = replaceHoldings(rows);
  console.log(`Synced ${n} holdings from ${srcPath} → data/holdings.db`);
  console.log(rows.map((r) => r.ticker).join(", "));
}

main();
