/**
 * Governance map smoke test.
 * Run: npm run test:gov
 */
import assert from "node:assert/strict";
import {
  BRIDGE_LARGE_MIN_CR,
  BRIDGE_SMALL_MAX_CR,
  scoreDirectorSeats,
} from "../src/lib/gov-score";
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
  assert.ok(scored.tiny_bridge, "LC + MIC (<500) should be big→micro");
  assert.equal(scored.ti_bridge, false, "400 Cr is not TI (<100)");
  assert.ok(scored.dir_score > 40);
  assert.equal(scored.board_count, 2);

  const tiBridge = scoreDirectorSeats(
    [
      { ticker: "BIGCO", market_cap_cr: 20_000 },
      { ticker: "TINYCO", market_cap_cr: 80 },
    ],
    { personId: "99887766", din: "99887766" },
  );
  assert.ok(tiBridge.ti_bridge, "LC + TI (<100) should be big→TI");
  assert.ok(tiBridge.tiny_bridge);

  const midSmall = scoreDirectorSeats(
    [
      { ticker: "MIDCO", market_cap_cr: BRIDGE_LARGE_MIN_CR + 500 },
      { ticker: "SMCO", market_cap_cr: BRIDGE_SMALL_MAX_CR - 100 },
    ],
    { personId: "22334455", din: "22334455" },
  );
  assert.ok(midSmall.bridge, "MC + SC should cap-bridge at tier boundary");
  assert.equal(
    midSmall.tiny_bridge,
    false,
    "SC (~4.9k) is not tiny (<500)",
  );
  assert.equal(midSmall.ti_bridge, false);

  const multiLc = scoreDirectorSeats(
    [
      { ticker: "TCS", market_cap_cr: 855_000 },
      { ticker: "TATASTEEL", market_cap_cr: 236_000 },
      { ticker: "TATAPOWER", market_cap_cr: 121_000 },
    ],
    { personId: "00121863", din: "00121863" },
  );
  assert.ok(multiLc.multi_lc, "3 LC boards should be multi-LC");
  assert.equal(multiLc.lc_n, 3);
  assert.equal(multiLc.ti_bridge, false);

  const gapOnly = scoreDirectorSeats(
    [
      { ticker: "A", market_cap_cr: 2_000 },
      { ticker: "B", market_cap_cr: 3_000 },
    ],
    { personId: "n:gap", din: null },
  );
  assert.equal(gapOnly.bridge, false, "two SC boards should not cap-bridge");

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
