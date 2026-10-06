/**
 * Resolve basket queries via local book + Groww, then write sector_rotation.db.
 * Usage: npx tsx scripts/import-sector-baskets.ts [json]
 */
import fs from "node:fs";
import path from "node:path";
import { resolveListingQuery } from "../src/lib/sector-rotation-resolve";
import { upsertRotationSectorByLabel } from "../src/lib/sector-rotation";

const file =
  process.argv[2] ||
  path.join(process.cwd(), "data/seeds/sector_rotation_baskets.json");

const baskets = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{
  label: string;
  queries: string[];
}>;

async function main() {
  for (const b of baskets) {
    const members = [];
    const failed: string[] = [];
    for (const q of b.queries) {
      const hit = await resolveListingQuery(q);
      if (!hit) {
        failed.push(q);
        continue;
      }
      members.push({
        ticker: hit.ticker,
        name: hit.name,
        market: hit.market,
      });
      process.stdout.write(
        `${b.label}\t${q}\t→\t${hit.ticker}\t${hit.name}\t${hit.source}\n`,
      );
    }
    if (failed.length) {
      throw new Error(`${b.label} unresolved: ${failed.join(", ")}`);
    }
    const sector = upsertRotationSectorByLabel(b.label, members);
    process.stdout.write(
      `saved ${sector.label} (${sector.members.length} listings)\n`,
    );
  }
}

void main();
