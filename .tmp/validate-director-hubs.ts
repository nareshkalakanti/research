import { openSqliteNamed } from "../src/lib/sqlite-utils";
import { DISCOVERY_MAX_TARGET_MCAP } from "../src/lib/company-network";

const db = openSqliteNamed("governance.db", { wal: true, readonly: true });

const seats = db
  .prepare(
    `SELECT
       COUNT(*) AS seats,
       COUNT(DISTINCT person_id) AS directors,
       COUNT(DISTINCT ticker) AS companies
     FROM board_seats`,
  )
  .get() as { seats: number; directors: number; companies: number };

const dups = db
  .prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT person_id, ticker FROM board_seats
       GROUP BY person_id, ticker HAVING COUNT(*) > 1
     )`,
  )
  .get() as { n: number };

const companyDupTickers = db
  .prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT ticker FROM companies GROUP BY ticker HAVING COUNT(*) > 1
     )`,
  )
  .get() as { n: number };

const mcap = db
  .prepare(
    `SELECT
       SUM(CASE WHEN m.market_cap IS NOT NULL AND m.market_cap > 0 THEN 1 ELSE 0 END) AS with_mcap,
       SUM(CASE WHEN m.market_cap IS NULL OR m.market_cap <= 0 THEN 1 ELSE 0 END) AS without_mcap
     FROM board_seats s
     LEFT JOIN company_metrics m ON m.ticker = s.ticker`,
  )
  .get() as { with_mcap: number; without_mcap: number };

const dirsMissingMcap = db
  .prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT s.person_id
       FROM board_seats s
       LEFT JOIN company_metrics m ON m.ticker = s.ticker
       GROUP BY s.person_id
       HAVING SUM(CASE WHEN m.market_cap IS NULL OR m.market_cap <= 0 THEN 1 ELSE 0 END) > 0
     )`,
  )
  .get() as { n: number };

const hub = db
  .prepare(
    `WITH seats AS (
       SELECT DISTINCT person_id, ticker FROM board_seats
     ),
     boards AS (
       SELECT person_id, COUNT(DISTINCT ticker) AS n
       FROM seats GROUP BY person_id
     ),
     groups AS (
       SELECT s.person_id, COUNT(DISTINCT g.group_key) AS n
       FROM seats s
       JOIN company_groups g ON g.ticker = s.ticker
       GROUP BY s.person_id
     )
     SELECT
       (SELECT COUNT(*) FROM boards WHERE n >= 2) AS d2,
       (SELECT COUNT(*) FROM boards WHERE n >= 3) AS d3,
       (SELECT COUNT(*) FROM boards WHERE n >= 4) AS d4,
       (SELECT COUNT(*) FROM boards WHERE n >= 5) AS d5,
       (SELECT COUNT(*) FROM boards WHERE n >= 6) AS d6,
       (SELECT COUNT(*) FROM boards WHERE n >= 7) AS d7,
       (SELECT COUNT(*) FROM boards WHERE n >= 10) AS d10,
       (SELECT COUNT(*) FROM groups WHERE n >= 2) AS g2,
       (SELECT COUNT(*) FROM groups WHERE n >= 3) AS g3,
       (SELECT COUNT(*) FROM groups WHERE n >= 4) AS g4,
       (SELECT COUNT(*) FROM groups WHERE n >= 5) AS g5`,
  )
  .get();

function bucket(min: number) {
  return db
    .prepare(
      `WITH people AS (
         SELECT person_id FROM board_seats
         GROUP BY person_id HAVING COUNT(DISTINCT ticker) >= ?
       )
       SELECT
         (SELECT COUNT(*) FROM people) AS directors,
         (SELECT COUNT(DISTINCT s.ticker) FROM board_seats s JOIN people p ON p.person_id = s.person_id) AS companies,
         (SELECT COUNT(DISTINCT g.group_key)
            FROM board_seats s
            JOIN people p ON p.person_id = s.person_id
            JOIN company_groups g ON g.ticker = s.ticker) AS groups,
         (SELECT COUNT(*) FROM (
            SELECT s.person_id
            FROM board_seats s
            JOIN people p ON p.person_id = s.person_id
            JOIN company_groups g ON g.ticker = s.ticker
            GROUP BY s.person_id
            HAVING COUNT(DISTINCT g.group_key) >= 2
         )) AS dirs_cross_groups`,
    )
    .get(min);
}

const CONNECTION_CASE = `
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM company_groups g1 WHERE g1.ticker = lj.ticker)
      OR NOT EXISTS (SELECT 1 FROM company_groups g2 WHERE g2.ticker = o.ticker)
      THEN 'unclassified'
    WHEN EXISTS (
      SELECT 1
      FROM company_groups g1
      JOIN company_groups g2 ON g2.group_key = g1.group_key
      WHERE g1.ticker = lj.ticker AND g2.ticker = o.ticker
    ) THEN 'same_group'
    ELSE 'cross_group'
  END`;

const maxTarget = DISCOVERY_MAX_TARGET_MCAP ?? 5000;
const newEdges = db
  .prepare(
    `WITH latest_joined AS (
        SELECT e.ticker, e.person_id, e.director_name, e.detected_at, e.event_type, e.id
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
          lj.person_id,
          o.ticker AS connected_ticker,
          ${CONNECTION_CASE} AS connection_type
        FROM latest_joined lj
        JOIN board_seats here
          ON here.ticker = lj.ticker AND here.person_id = lj.person_id
        JOIN board_seats o
          ON o.person_id = lj.person_id AND o.ticker <> lj.ticker
        JOIN company_metrics tm ON tm.ticker = lj.ticker
        JOIN company_metrics cm ON cm.ticker = o.ticker
        WHERE tm.market_cap > 0 AND cm.market_cap > 0
          AND tm.market_cap < ?
          AND julianday('now') - julianday(lj.detected_at) <= 180
      )
      SELECT
        COUNT(*) AS edges,
        COUNT(DISTINCT person_id) AS directors,
        COUNT(DISTINCT person_id || '|' || target_ticker || '|' || connected_ticker) AS rels
      FROM new_edges`,
  )
  .get(maxTarget) as { edges: number; directors: number; rels: number };

console.log(
  JSON.stringify(
    {
      seats,
      duplicate_person_ticker: dups.n,
      duplicate_company_tickers: companyDupTickers.n,
      mcap,
      directors_missing_any_mcap: dirsMissingMcap.n,
      board_buckets: {
        "2+": bucket(2),
        "3+": bucket(3),
        "4+": bucket(4),
        "5+": bucket(5),
        "6+": bucket(6),
        "7+": bucket(7),
        "10+": bucket(10),
      },
      group_coverage: hub,
      canonical_new: newEdges,
    },
    null,
    2,
  ),
);
db.close();
