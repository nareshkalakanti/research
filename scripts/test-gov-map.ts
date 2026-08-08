/**
 * Governance map smoke test.
 * Run: npm run test:gov
 */
import assert from "node:assert/strict";
import { scoreDirectorSeats } from "../src/lib/gov-score";
import {
  governanceMapStats,
  loadGovernanceMap,
} from "../src/lib/governance-map";

function main() {
  const scored = scoreDirectorSeats(
    [
      {
        ticker: "RELIANCE",
        market_cap_cr: 180_000,
        designation: "Independent Director",
        category: "Independent",
      },
      {
        ticker: "SMALLCO",
        market_cap_cr: 400,
        designation: "Non-Executive Director",
      },
    ],
    { personId: "12345678", din: "12345678" },
  );
  assert.ok(scored.din_backed);
  assert.ok(scored.bridge);
  assert.ok(scored.dir_score > 40);
  assert.equal(scored.board_count, 2);

  const rows = loadGovernanceMap({ minBoards: 2 });
  assert.ok(rows.length > 100, `expected many directors, got ${rows.length}`);
  const top = rows[0];
  assert.ok(top);
  assert.ok(top.companies.length >= 2);
  assert.ok(typeof top.dir_score === "number");

  const stats = governanceMapStats(rows);
  assert.equal(stats.directors, rows.length);
  assert.ok(stats.companies > 50);

  console.log("✓ score bridge", scored.dir_score, "boards", scored.board_count);
  console.log(
    "✓ map rows",
    rows.length,
    "companies",
    stats.companies,
    "DIN",
    stats.din_backed,
    "bridges",
    stats.bridges,
  );
  console.log("✓ top", top.name, top.dir_score, top.tickers.slice(0, 60));
  console.log("\nAll governance map checks passed.");
}

main();
