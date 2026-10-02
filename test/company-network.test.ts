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

db.exec(`
  CREATE TABLE board_seat_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    person_id TEXT NOT NULL,
    director_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    detected_at TEXT NOT NULL
  );
  INSERT INTO board_seat_events (ticker, person_id, director_name, event_type, detected_at) VALUES
    ('AAA','p1','One','joined','2026-09-01T00:00:00Z'),
    ('AAA','p1','One','joined','2026-10-01T00:00:00Z'),
    ('AAA','p9','Gone','joined','2026-10-01T00:00:00Z'),
    ('BBB','p1','One','resigned','2026-10-01T00:00:00Z');
`);
db.exec(COMPANY_GROUPS_TABLE_SQL);

const newConnSql = `
  WITH latest_joined AS (
    SELECT e.ticker, e.person_id, e.director_name, e.detected_at
    FROM board_seat_events e
    JOIN (
      SELECT ticker, person_id, MAX(id) AS id
      FROM board_seat_events
      WHERE event_type = 'joined'
      GROUP BY ticker, person_id
    ) x ON x.id = e.id
  )
  SELECT
    lj.ticker AS target_ticker,
    o.ticker AS connected_ticker,
    lj.detected_at AS event_date,
    ROUND(cm.market_cap / tm.market_cap, 1) AS market_cap_ratio,
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM company_groups g1 WHERE g1.ticker = lj.ticker)
        OR NOT EXISTS (SELECT 1 FROM company_groups g2 WHERE g2.ticker = o.ticker)
        THEN 'unclassified'
      WHEN EXISTS (
        SELECT 1 FROM company_groups g1
        JOIN company_groups g2 ON g2.group_key = g1.group_key
        WHERE g1.ticker = lj.ticker AND g2.ticker = o.ticker
      ) THEN 'same_group'
      ELSE 'cross_group'
    END AS connection_type
  FROM latest_joined lj
  JOIN board_seats here ON here.ticker = lj.ticker AND here.person_id = lj.person_id
  JOIN board_seats o ON o.person_id = lj.person_id AND o.ticker <> lj.ticker
  JOIN company_metrics tm ON tm.ticker = lj.ticker
  JOIN company_metrics cm ON cm.ticker = o.ticker
  WHERE tm.market_cap > 0 AND tm.market_cap < 5000 AND cm.market_cap > 0
  ORDER BY connected_ticker
`;
const newRows = db.prepare(newConnSql).all() as Array<{
  target_ticker: string;
  connected_ticker: string;
  event_date: string;
  market_cap_ratio: number;
  connection_type: string;
}>;
assert.ok(newRows.every((r) => r.target_ticker === "AAA"));
assert.ok(!newRows.some((r) => r.target_ticker === "AAA" && r.connected_ticker === "AAA"));
assert.equal(newRows.filter((r) => r.event_date < "2026-10-01").length, 0);
assert.equal(
  new Set(newRows.map((r) => `${r.target_ticker}|${r.connected_ticker}`)).size,
  newRows.length,
);
assert.ok(!newRows.some((r) => r.connected_ticker === "CCC" && r.market_cap_ratio == null));
const gone = db
  .prepare(
    `SELECT COUNT(*) AS n FROM board_seat_events e
     LEFT JOIN board_seats s ON s.ticker=e.ticker AND s.person_id=e.person_id
     WHERE e.event_type='joined' AND e.person_id='p9' AND s.person_id IS NULL`,
  )
  .get() as { n: number };
assert.equal(gone.n, 1);
assert.ok(!newRows.some((r) => r.target_ticker === "AAA" && r.connected_ticker === "p9"));

db.exec(`
  INSERT INTO companies VALUES ('DDD','Ddd Ltd');
  INSERT INTO company_metrics (ticker, market_cap, updated_at) VALUES ('DDD', 60000, 'x');
  INSERT INTO board_seats (ticker, person_id) VALUES ('DDD','p1');
  INSERT INTO company_groups VALUES ('DDD','gz','Group Z','x');
`);
const gapSql = `
  WITH latest_joined AS (
    SELECT e.ticker, e.person_id, e.director_name, e.detected_at, e.id
    FROM board_seat_events e
    JOIN (
      SELECT ticker, person_id, MAX(id) AS id
      FROM board_seat_events
      WHERE event_type = 'joined'
      GROUP BY ticker, person_id
    ) x ON x.id = e.id
  ),
  new_edges AS (
    SELECT
      lj.ticker AS target_ticker,
      o.ticker AS connected_ticker,
      cm.market_cap AS connected_market_cap,
      ROUND(cm.market_cap / tm.market_cap, 1) AS market_cap_ratio,
      CASE
        WHEN NOT EXISTS (SELECT 1 FROM company_groups g1 WHERE g1.ticker = lj.ticker)
          OR NOT EXISTS (SELECT 1 FROM company_groups g2 WHERE g2.ticker = o.ticker)
          THEN 'unclassified'
        WHEN EXISTS (
          SELECT 1 FROM company_groups g1
          JOIN company_groups g2 ON g2.group_key = g1.group_key
          WHERE g1.ticker = lj.ticker AND g2.ticker = o.ticker
        ) THEN 'same_group'
        ELSE 'cross_group'
      END AS connection_type,
      dn.company_count AS board_count,
      lj.person_id
    FROM latest_joined lj
    JOIN board_seats here ON here.ticker = lj.ticker AND here.person_id = lj.person_id
    JOIN board_seats o ON o.person_id = lj.person_id AND o.ticker <> lj.ticker
    JOIN company_metrics tm ON tm.ticker = lj.ticker
    JOIN company_metrics cm ON cm.ticker = o.ticker
    LEFT JOIN director_network dn ON dn.person_id = lj.person_id
    WHERE tm.market_cap > 0 AND tm.market_cap < 5000 AND cm.market_cap > 0
  )
  SELECT
    target_ticker,
    COUNT(DISTINCT connected_ticker) AS connected_companies,
    COUNT(DISTINCT CASE WHEN connected_market_cap >= 10000 THEN connected_ticker END) AS n_10k,
    COUNT(DISTINCT CASE WHEN connected_market_cap >= 25000 THEN connected_ticker END) AS n_25k,
    COUNT(DISTINCT CASE WHEN connected_market_cap >= 50000 THEN connected_ticker END) AS n_50k,
    MAX(connected_market_cap) AS largest_connected_mcap,
    MAX(market_cap_ratio) AS largest_ratio,
    COUNT(DISTINCT CASE WHEN connection_type = 'cross_group' THEN connected_ticker END) AS cross_group_count,
    COUNT(DISTINCT CASE WHEN IFNULL(board_count, 0) >= 3 THEN person_id END) AS multi_board_director_count
  FROM new_edges
  GROUP BY target_ticker
`;
const gap = db.prepare(gapSql).get() as {
  target_ticker: string;
  connected_companies: number;
  n_10k: number;
  n_25k: number;
  n_50k: number;
  largest_connected_mcap: number;
  largest_ratio: number;
  cross_group_count: number;
  multi_board_director_count: number;
};
assert.equal(gap.target_ticker, "AAA");
assert.equal(gap.connected_companies, 2);
assert.equal(gap.n_10k, 2);
assert.equal(gap.n_25k, 2);
assert.equal(gap.n_50k, 1);
assert.equal(gap.largest_connected_mcap, 60000);
assert.equal(gap.largest_ratio, 85.7);
assert.equal(gap.cross_group_count, 1);
assert.equal(gap.multi_board_director_count, 1);

console.log("company-network.test.ts ok");
