/**
 * Governance seat diff smoke test.
 * Run: npm run test:gov-changes
 */
import assert from "node:assert/strict";
import { listRecentSeatEvents } from "../src/lib/governance-changes";
import {
  getGovernanceWriteDb,
  saveCompanyBoard,
} from "../src/lib/governance-write";

const TEST_TICKER = "GOVTEST1";

function cleanup() {
  const db = getGovernanceWriteDb();
  db.prepare(`DELETE FROM board_seat_events WHERE ticker = ?`).run(TEST_TICKER);
  db.prepare(`DELETE FROM board_seats WHERE ticker = ?`).run(TEST_TICKER);
  db.prepare(`DELETE FROM companies WHERE ticker = ?`).run(TEST_TICKER);
}

function main() {
  cleanup();

  saveCompanyBoard({
    ticker: TEST_TICKER,
    name: "Governance Test Co",
    market: "NSE",
    seats: [
      {
        din: "11111111",
        name: "Alpha Director",
        designation: "Independent Director",
        category: "Independent",
        source: "test",
      },
      {
        din: "00121863",
        name: "Chandrasekaran Natarajan",
        designation: "Chairperson",
        category: "Non-Executive",
        source: "test",
      },
    ],
    replaceSeats: true,
    protectDinBoard: false,
  });

  const first = listRecentSeatEvents({ ticker: TEST_TICKER, limit: 5 });
  assert.equal(first.length, 0, "first save should not log events");

  saveCompanyBoard({
    ticker: TEST_TICKER,
    name: "Governance Test Co",
    market: "NSE",
    seats: [
      {
        din: "11111111",
        name: "Alpha Director",
        designation: "Managing Director",
        category: "Executive",
        source: "test",
      },
      {
        din: "22222222",
        name: "Beta Director",
        designation: "Independent Director",
        category: "Independent",
        source: "test",
      },
    ],
    replaceSeats: true,
    protectDinBoard: false,
  });

  const events = listRecentSeatEvents({ ticker: TEST_TICKER, limit: 10 });
  assert.equal(events.length, 3, `expected 3 events, got ${events.length}`);
  assert.ok(
    events.some(
      (e) =>
        e.event_type === "resigned" &&
        e.person_id === "00121863" &&
        e.director_name.includes("Chandrasekaran"),
    ),
    "Chandrasekaran resignation should be recorded",
  );
  assert.ok(
    events.some((e) => e.event_type === "joined" && e.person_id === "22222222"),
    "Beta join should be recorded",
  );
  assert.ok(
    events.some((e) => e.event_type === "role_changed" && e.person_id === "11111111"),
    "Alpha role change should be recorded",
  );

  const watched = listRecentSeatEvents({ watchOnly: true, limit: 10 });
  assert.ok(
    watched.some((e) => e.person_id === "00121863"),
    "watched filter should include Chandrasekaran",
  );

  cleanup();
  console.log("✓ seat diff joined / resigned / role_changed");
  console.log("✓ watchlist filter for Chandrasekaran");
  console.log("\nAll governance change checks passed.");
}

main();
