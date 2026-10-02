/**
 * company_network counts distinct people shared by each unordered ticker pair.
 * Gold tickers are fixtures, not production data.
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { COMPANY_METRICS_TABLE_SQL } from "../src/lib/company-metrics";
import { COMPANY_GROUPS_TABLE_SQL, companyGroupLinks } from "../src/lib/company-groups";
import {
  LARGE_CONNECTION_MCAP_CR,
  NETWORK_CONNECTION_GROUPS_VIEW_SQL,
  networkNapkin,
} from "../src/lib/network-profile";
import {
  DIRECTOR_CONNECTIONS_VIEW_SQL,
  DISCOVERY_MAX_TARGET_MCAP,
  NETWORK_DISCOVERY_VIEW_SQL,
  COMPANY_CONNECTIVITY_VIEW_SQL,
  DEFAULT_CONNECTIVITY_CAPS,
  COMPANY_NETWORK_VIEW_SQL,
  DIRECTOR_NETWORK_VIEW_SQL,
} from "../src/lib/company-network";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE board_seats (
    ticker TEXT NOT NULL,
    person_id TEXT NOT NULL
  );
`);
db.exec(COMPANY_NETWORK_VIEW_SQL);

const insert = db.prepare(
  "INSERT INTO board_seats (ticker, person_id) VALUES (?, ?)",
);
insert.run("AAA", "p1");
insert.run("BBB", "p1");
insert.run("AAA", "p2");
insert.run("BBB", "p2");
insert.run("AAA", "p3");
insert.run("CCC", "p3");
insert.run("BBB", "p4");

const rows = db
  .prepare(
    `SELECT ticker_a, ticker_b, shared_directors
     FROM company_network
     ORDER BY shared_directors DESC, ticker_a, ticker_b`,
  )
  .all() as Array<{ ticker_a: string; ticker_b: string; shared_directors: number }>;

assert.deepEqual(rows, [
  { ticker_a: "AAA", ticker_b: "BBB", shared_directors: 2 },
  { ticker_a: "AAA", ticker_b: "CCC", shared_directors: 1 },
]);

const same = db
  .prepare(
    "SELECT COUNT(*) AS n FROM company_network WHERE ticker_a = ticker_b",
  )
  .get() as { n: number };
assert.equal(same.n, 0);

db.exec(`
  CREATE TABLE directors (person_id TEXT PRIMARY KEY, name TEXT);
  INSERT INTO directors VALUES ('p1','One'),('p2','Two'),('p3','Three'),('p4','Four');
`);
db.exec(DIRECTOR_NETWORK_VIEW_SQL);
const directors = db
  .prepare(
    `SELECT person_id, name, company_count FROM director_network
     WHERE company_count >= 2
     ORDER BY company_count DESC, person_id`,
  )
  .all();
assert.deepEqual(directors, [
  { person_id: "p1", name: "One", company_count: 2 },
  { person_id: "p2", name: "Two", company_count: 2 },
  { person_id: "p3", name: "Three", company_count: 2 },
]);

db.exec(COMPANY_CONNECTIVITY_VIEW_SQL);
const connectivity = db
  .prepare(
    `SELECT ticker, total_directors, externally_connected_directors
     FROM company_connectivity ORDER BY ticker`,
  )
  .all();
assert.deepEqual(connectivity, [
  { ticker: "AAA", total_directors: 3, externally_connected_directors: 3 },
  { ticker: "BBB", total_directors: 3, externally_connected_directors: 2 },
  { ticker: "CCC", total_directors: 1, externally_connected_directors: 1 },
]);

assert.deepEqual(DEFAULT_CONNECTIVITY_CAPS, ["TI", "MIC", "SC"]);

db.exec(`
  ALTER TABLE board_seats ADD COLUMN designation TEXT;
  CREATE TABLE companies (ticker TEXT PRIMARY KEY, name TEXT);
  INSERT INTO companies VALUES ('AAA','Aaa Ltd'),('BBB','Bbb Ltd'),('CCC','Ccc Ltd');
`);
db.exec(COMPANY_METRICS_TABLE_SQL);
db.exec(`
  INSERT INTO company_metrics (ticker, market_cap, updated_at) VALUES
    ('AAA', 700, 'x'), ('BBB', 35000, 'x'), ('CCC', NULL, 'x');
`);
db.exec(DIRECTOR_CONNECTIONS_VIEW_SQL);
db.exec(NETWORK_DISCOVERY_VIEW_SQL);

const aaaLinks = db
  .prepare(
    `SELECT director, connected_ticker FROM director_connections
     WHERE target_ticker = 'AAA' ORDER BY director, connected_ticker`,
  )
  .all();
assert.deepEqual(aaaLinks, [
  { director: "One", connected_ticker: "BBB" },
  { director: "Three", connected_ticker: "CCC" },
  { director: "Two", connected_ticker: "BBB" },
]);

const discovery = db
  .prepare(
    `SELECT target_ticker, connected_ticker, market_cap_ratio
     FROM network_discovery
     WHERE target_market_cap < 5000
     ORDER BY market_cap_ratio IS NULL, market_cap_ratio DESC, connected_ticker`,
  )
  .all();
assert.deepEqual(discovery, [
  { target_ticker: "AAA", connected_ticker: "BBB", market_cap_ratio: 50 },
  { target_ticker: "AAA", connected_ticker: "BBB", market_cap_ratio: 50 },
  { target_ticker: "AAA", connected_ticker: "CCC", market_cap_ratio: null },
]);
assert.equal(DISCOVERY_MAX_TARGET_MCAP, 5000);

assert.deepEqual(
  companyGroupLinks([
    { family_name: "Group X", group_id: "gx", companies: [{ ticker: "aaa" }, { ticker: "BBB" }] },
    { family_name: "Group Y", companies: [{ ticker: "BBB" }] },
  ]),
  [
    { ticker: "AAA", group_key: "gx", group_name: "Group X" },
    { ticker: "BBB", group_key: "gx", group_name: "Group X" },
    { ticker: "BBB", group_key: "Group Y", group_name: "Group Y" },
  ],
);

db.exec(COMPANY_GROUPS_TABLE_SQL);
db.exec(NETWORK_CONNECTION_GROUPS_VIEW_SQL);
const typesFor = () =>
  db
    .prepare(
      `SELECT DISTINCT target_ticker, connected_ticker, connection_type
       FROM network_connection_groups
       WHERE target_ticker = 'AAA' ORDER BY connected_ticker`,
    )
    .all();

// AAA in X and Y; BBB in Y only (shares Y); CCC has no group.
db.exec(`
  INSERT INTO company_groups VALUES
    ('AAA','gx','Group X','x'), ('AAA','gy','Group Y','x'), ('BBB','gy','Group Y','x');
`);
assert.deepEqual(typesFor(), [
  { target_ticker: "AAA", connected_ticker: "BBB", connection_type: "same_group" },
  { target_ticker: "AAA", connected_ticker: "CCC", connection_type: "unclassified" },
]);

// CCC gets a group AAA does not share → cross_group.
db.exec(`INSERT INTO company_groups VALUES ('CCC','gz','Group Z','x')`);
assert.deepEqual(typesFor(), [
  { target_ticker: "AAA", connected_ticker: "BBB", connection_type: "same_group" },
  { target_ticker: "AAA", connected_ticker: "CCC", connection_type: "cross_group" },
]);

const napkin = networkNapkin({ pe: 34.8, eps_cagr_5y: 0.27 }, undefined);
assert.equal(napkin.required_cagr, Math.pow(34.8 * 0.3, 1 / 5) - 1);
assert.equal(napkin.growth_gap, 0.27 - (Math.pow(34.8 * 0.3, 1 / 5) - 1));
assert.equal(napkin.status, "N/A");
assert.equal(networkNapkin({ pe: null, eps_cagr_5y: 0.27 }, undefined).growth_gap, null);
assert.equal(LARGE_CONNECTION_MCAP_CR, 10_000);

console.log("company-network.test.ts ok");
