/**
 * Stock ego graph: connected companies are other listed boards, not the hub.
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "node:path";
import { loadStockBoardNetwork } from "../src/lib/governance-map";

const dbPath = path.join(process.cwd(), "data", "governance.db");
const db = new Database(dbPath, { readonly: true });

const pair = db
  .prepare(
    `
    SELECT s1.ticker AS a, s2.ticker AS b
    FROM board_seats s1
    JOIN board_seats s2
      ON s1.person_id = s2.person_id
     AND UPPER(s1.ticker) < UPPER(s2.ticker)
    LIMIT 1
    `,
  )
  .get() as { a: string; b: string } | undefined;
db.close();

assert.ok(pair, "need at least one director on two listed boards");
const net = loadStockBoardNetwork(pair.a);
assert.ok(net);
assert.equal(net.ticker.toUpperCase(), pair.a.toUpperCase());
assert.ok(
  net.companies.some((c) => c.ticker.toUpperCase() === pair.a.toUpperCase()),
);
assert.ok(
  net.companies.some((c) => c.ticker.toUpperCase() === pair.b.toUpperCase()),
  "other listed board must be a company node",
);
const connected = net.companies.filter(
  (c) => c.ticker.toUpperCase() !== pair.a.toUpperCase(),
);
assert.ok(connected.length >= 1);
