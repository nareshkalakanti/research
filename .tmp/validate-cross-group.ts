import { openSqliteNamed } from "../src/lib/sqlite-utils";

const db = openSqliteNamed("governance.db", { wal: true, readonly: true });

const sql = `
WITH seats AS (
  SELECT DISTINCT bs.person_id, bs.ticker
  FROM board_seats bs
  JOIN company_groups cg ON cg.ticker = bs.ticker
),
pairs AS (
  SELECT
    a.person_id,
    a.ticker AS ticker_a,
    b.ticker AS ticker_b
  FROM seats a
  JOIN seats b
    ON b.person_id = a.person_id
   AND a.ticker < b.ticker
  WHERE NOT EXISTS (
    SELECT 1
    FROM company_groups ga
    JOIN company_groups gb ON gb.group_key = ga.group_key
    WHERE ga.ticker = a.ticker AND gb.ticker = b.ticker
  )
)
SELECT
  (SELECT COUNT(*) FROM pairs) AS relationships,
  (SELECT COUNT(DISTINCT person_id) FROM pairs) AS directors,
  (SELECT COUNT(*) FROM (
     SELECT ticker_a AS t FROM pairs UNION SELECT ticker_b FROM pairs
  )) AS companies,
  (SELECT COUNT(*) FROM (
     SELECT person_id, ticker_a, ticker_b FROM pairs
     GROUP BY person_id, ticker_a, ticker_b HAVING COUNT(*) > 1
  )) AS duplicate_pairs,
  (SELECT COUNT(*) FROM pairs WHERE ticker_a = ticker_b) AS same_ticker,
  (SELECT COUNT(*) FROM pairs p
    WHERE EXISTS (
      SELECT 1 FROM company_groups ga
      JOIN company_groups gb ON gb.group_key = ga.group_key
      WHERE ga.ticker = p.ticker_a AND gb.ticker = p.ticker_b
    )) AS shared_group,
  (SELECT COUNT(*) FROM pairs p
    WHERE NOT EXISTS (SELECT 1 FROM company_groups g WHERE g.ticker = p.ticker_a)
       OR NOT EXISTS (SELECT 1 FROM company_groups g WHERE g.ticker = p.ticker_b)
  ) AS missing_group
`;

const base = db.prepare(sql).get();

const mcap = db
  .prepare(
    `WITH seats AS (
       SELECT DISTINCT bs.person_id, bs.ticker
       FROM board_seats bs
       JOIN company_groups cg ON cg.ticker = bs.ticker
     ),
     pairs AS (
       SELECT a.person_id, a.ticker AS ticker_a, b.ticker AS ticker_b
       FROM seats a
       JOIN seats b ON b.person_id = a.person_id AND a.ticker < b.ticker
       WHERE NOT EXISTS (
         SELECT 1 FROM company_groups ga
         JOIN company_groups gb ON gb.group_key = ga.group_key
         WHERE ga.ticker = a.ticker AND gb.ticker = b.ticker
       )
     )
     SELECT
       SUM(CASE WHEN ma.market_cap > 0 AND mb.market_cap > 0 THEN 1 ELSE 0 END) AS both_mcap,
       SUM(CASE WHEN IFNULL(ma.market_cap,0) <= 0 OR IFNULL(mb.market_cap,0) <= 0 THEN 1 ELSE 0 END) AS missing_mcap
     FROM pairs p
     LEFT JOIN company_metrics ma ON ma.ticker = p.ticker_a
     LEFT JOIN company_metrics mb ON mb.ticker = p.ticker_b`,
  )
  .get();

const dirGroups = db
  .prepare(
    `WITH seats AS (
       SELECT DISTINCT bs.person_id, bs.ticker
       FROM board_seats bs JOIN company_groups cg ON cg.ticker = bs.ticker
     ),
     pairs AS (
       SELECT a.person_id, a.ticker AS ticker_a, b.ticker AS ticker_b
       FROM seats a
       JOIN seats b ON b.person_id = a.person_id AND a.ticker < b.ticker
       WHERE NOT EXISTS (
         SELECT 1 FROM company_groups ga
         JOIN company_groups gb ON gb.group_key = ga.group_key
         WHERE ga.ticker = a.ticker AND gb.ticker = b.ticker
       )
     ),
     dir_g AS (
       SELECT p.person_id, COUNT(DISTINCT g.group_key) AS n
       FROM pairs p
       JOIN company_groups g ON g.ticker IN (p.ticker_a, p.ticker_b)
       GROUP BY p.person_id
     )
     SELECT
       SUM(CASE WHEN n >= 2 THEN 1 ELSE 0 END) AS g2,
       SUM(CASE WHEN n >= 3 THEN 1 ELSE 0 END) AS g3,
       SUM(CASE WHEN n >= 4 THEN 1 ELSE 0 END) AS g4
     FROM dir_g`,
  )
  .get();

const coGroups = db
  .prepare(
    `WITH seats AS (
       SELECT DISTINCT bs.person_id, bs.ticker
       FROM board_seats bs JOIN company_groups cg ON cg.ticker = bs.ticker
     ),
     pairs AS (
       SELECT a.person_id, a.ticker AS ticker_a, b.ticker AS ticker_b
       FROM seats a
       JOIN seats b ON b.person_id = a.person_id AND a.ticker < b.ticker
       WHERE NOT EXISTS (
         SELECT 1 FROM company_groups ga
         JOIN company_groups gb ON gb.group_key = ga.group_key
         WHERE ga.ticker = a.ticker AND gb.ticker = b.ticker
       )
     ),
     cos AS (
       SELECT ticker_a AS ticker FROM pairs UNION SELECT ticker_b FROM pairs
     ),
     co_g AS (
       SELECT c.ticker, COUNT(DISTINCT g2.group_key) AS other_groups
       FROM cos c
       JOIN pairs p ON p.ticker_a = c.ticker OR p.ticker_b = c.ticker
       JOIN company_groups g2 ON g2.ticker = CASE WHEN p.ticker_a = c.ticker THEN p.ticker_b ELSE p.ticker_a END
       GROUP BY c.ticker
     )
     SELECT
       COUNT(*) AS companies_with_xg,
       SUM(CASE WHEN other_groups >= 2 THEN 1 ELSE 0 END) AS c2,
       SUM(CASE WHEN other_groups >= 3 THEN 1 ELSE 0 END) AS c3
     FROM co_g`,
  )
  .get();

const groupPairs = db
  .prepare(
    `WITH seats AS (
       SELECT DISTINCT bs.person_id, bs.ticker
       FROM board_seats bs JOIN company_groups cg ON cg.ticker = bs.ticker
     ),
     pairs AS (
       SELECT a.person_id, a.ticker AS ticker_a, b.ticker AS ticker_b
       FROM seats a
       JOIN seats b ON b.person_id = a.person_id AND a.ticker < b.ticker
       WHERE NOT EXISTS (
         SELECT 1 FROM company_groups ga
         JOIN company_groups gb ON gb.group_key = ga.group_key
         WHERE ga.ticker = a.ticker AND gb.ticker = b.ticker
       )
     ),
     gp AS (
       SELECT DISTINCT
         CASE WHEN ga.group_key < gb.group_key THEN ga.group_key ELSE gb.group_key END AS g1,
         CASE WHEN ga.group_key < gb.group_key THEN gb.group_key ELSE ga.group_key END AS g2
       FROM pairs p
       JOIN company_groups ga ON ga.ticker = p.ticker_a
       JOIN company_groups gb ON gb.ticker = p.ticker_b
       WHERE ga.group_key <> gb.group_key
     )
     SELECT COUNT(*) AS group_pairs,
            (SELECT COUNT(*) FROM (
              SELECT g1 AS g FROM gp UNION SELECT g2 FROM gp
            )) AS groups
     FROM gp`,
  )
  .get();

db.close();
console.log(JSON.stringify({ base, mcap, dirGroups, coGroups, groupPairs }, null, 2));
