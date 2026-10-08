WITH current_edges AS (
    SELECT DISTINCT
        a.ticker AS ticker_a,
        b.ticker AS ticker_b,
        a.person_id
    FROM board_seats a
    JOIN board_seats b
      ON b.person_id = a.person_id
     AND b.ticker > a.ticker
    WHERE a.ticker <> b.ticker
),
company_connections AS (
    SELECT
        ce.ticker_a AS target_ticker,
        ce.ticker_b AS connected_ticker,
        ce.person_id
    FROM current_edges ce
    UNION ALL
    SELECT
        ce.ticker_b AS target_ticker,
        ce.ticker_a AS connected_ticker,
        ce.person_id
    FROM current_edges ce
),
target_stats AS (
    SELECT
        cc.target_ticker,
        COUNT(DISTINCT cc.connected_ticker) AS connected_companies,
        COUNT(DISTINCT cc.person_id) AS connecting_directors,
        MAX(cm.market_cap) AS largest_connected_mcap,
        COUNT(DISTINCT CASE WHEN cm.market_cap >= 5000 THEN cc.connected_ticker END) AS connected_5000_plus,
        COUNT(DISTINCT CASE WHEN cm.market_cap >= 10000 THEN cc.connected_ticker END) AS connected_10000_plus
    FROM company_connections cc
    JOIN company_metrics cm ON cm.ticker = cc.connected_ticker
    WHERE cm.market_cap > 0
    GROUP BY cc.target_ticker
),
director_boards AS (
    SELECT person_id, COUNT(DISTINCT ticker) AS board_count
    FROM board_seats
    GROUP BY person_id
),
target_director_stats AS (
    SELECT
        bs.ticker,
        COUNT(DISTINCT CASE WHEN db.board_count >= 3 THEN bs.person_id END) AS directors_3_plus_boards
    FROM board_seats bs
    JOIN director_boards db ON db.person_id = bs.person_id
    GROUP BY bs.ticker
),
cross_group AS (
    SELECT DISTINCT
        cc.target_ticker,
        cc.connected_ticker
    FROM company_connections cc
    WHERE EXISTS (SELECT 1 FROM company_groups g1 WHERE g1.ticker = cc.target_ticker)
      AND EXISTS (SELECT 1 FROM company_groups g2 WHERE g2.ticker = cc.connected_ticker)
      AND NOT EXISTS (
        SELECT 1
        FROM company_groups g1
        JOIN company_groups g2 ON g2.group_key = g1.group_key
        WHERE g1.ticker = cc.target_ticker
          AND g2.ticker = cc.connected_ticker
      )
),
cross_group_stats AS (
    SELECT target_ticker, COUNT(*) AS cross_group_connections
    FROM cross_group
    GROUP BY target_ticker
)
SELECT
    c.ticker,
    c.name AS company,
    tm.market_cap,
    COALESCE(ts.connected_companies, 0) AS connected_companies,
    COALESCE(ts.connecting_directors, 0) AS connecting_directors,
    COALESCE(tds.directors_3_plus_boards, 0) AS directors_3_plus_boards,
    ts.largest_connected_mcap AS largest_connected_mcap,
    COALESCE(ts.connected_5000_plus, 0) AS connected_5000_plus,
    COALESCE(ts.connected_10000_plus, 0) AS connected_10000_plus,
    COALESCE(cgs.cross_group_connections, 0) AS cross_group_connections,
    CASE WHEN COALESCE(tds.directors_3_plus_boards, 0) > 0 THEN 1 ELSE 0 END AS has_3plus_board_director,
    CASE WHEN COALESCE(ts.connected_5000_plus, 0) > 0 THEN 1 ELSE 0 END AS has_5k_connection,
    CASE WHEN COALESCE(ts.connected_10000_plus, 0) > 0 THEN 1 ELSE 0 END AS has_10k_connection,
    CASE WHEN COALESCE(cgs.cross_group_connections, 0) > 0 THEN 1 ELSE 0 END AS has_cross_group,
    CASE WHEN COALESCE(ts.connected_companies, 0) >= 2 THEN 1 ELSE 0 END AS has_2plus_companies,
    CASE WHEN COALESCE(ts.connecting_directors, 0) >= 2 THEN 1 ELSE 0 END AS has_2plus_directors
FROM companies c
JOIN company_metrics tm ON tm.ticker = c.ticker
LEFT JOIN target_stats ts ON ts.target_ticker = c.ticker
LEFT JOIN target_director_stats tds ON tds.ticker = c.ticker
LEFT JOIN cross_group_stats cgs ON cgs.target_ticker = c.ticker
WHERE tm.market_cap > 0
  AND tm.market_cap < 1000
  AND (
       COALESCE(tds.directors_3_plus_boards, 0) > 0
    OR COALESCE(ts.connected_5000_plus, 0) > 0
    OR COALESCE(ts.connected_10000_plus, 0) > 0
    OR COALESCE(cgs.cross_group_connections, 0) > 0
    OR COALESCE(ts.connected_companies, 0) >= 2
    OR COALESCE(ts.connecting_directors, 0) >= 2
  )
ORDER BY tm.market_cap ASC;
