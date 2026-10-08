import { openSqliteNamed } from "../src/lib/sqlite-utils";

const db = openSqliteNamed("governance.db", { wal: true, readonly: true });

const seats = db
  .prepare(
    `SELECT COUNT(*) AS seats,
            COUNT(DISTINCT person_id) AS directors,
            COUNT(DISTINCT ticker) AS companies
     FROM board_seats`,
  )
  .get() as { seats: number; directors: number; companies: number };

const pairStats = db
  .prepare(
    `WITH pairs AS (
       SELECT a.ticker AS ticker_a, b.ticker AS ticker_b,
              COUNT(DISTINCT a.person_id) AS shared
       FROM board_seats a
       JOIN board_seats b
         ON b.person_id = a.person_id
        AND a.ticker < b.ticker
       GROUP BY a.ticker, b.ticker
     )
     SELECT
       COUNT(*) AS unique_pairs,
       SUM(CASE WHEN ticker_a = ticker_b THEN 1 ELSE 0 END) AS self_pairs,
       SUM(CASE WHEN shared >= 2 THEN 1 ELSE 0 END) AS multi_director_pairs,
       SUM(CASE
         WHEN EXISTS (SELECT 1 FROM company_groups ga WHERE ga.ticker = ticker_a)
          AND EXISTS (SELECT 1 FROM company_groups gb WHERE gb.ticker = ticker_b)
          AND NOT EXISTS (
            SELECT 1 FROM company_groups ga
            JOIN company_groups gb ON gb.group_key = ga.group_key
            WHERE ga.ticker = ticker_a AND gb.ticker = ticker_b
          )
         THEN 1 ELSE 0 END) AS cross_group_pairs
     FROM pairs`,
  )
  .get() as {
  unique_pairs: number;
  self_pairs: number;
  multi_director_pairs: number;
  cross_group_pairs: number;
};

const pairs = db
  .prepare(
    `SELECT a.ticker AS ticker_a, b.ticker AS ticker_b
     FROM board_seats a
     JOIN board_seats b
       ON b.person_id = a.person_id
      AND a.ticker < b.ticker
     GROUP BY a.ticker, b.ticker`,
  )
  .all() as Array<{ ticker_a: string; ticker_b: string }>;

const dups = pairs.length - new Set(pairs.map((p) => `${p.ticker_a}|${p.ticker_b}`)).size;

const parent = new Map<string, string>();
function find(x: string): string {
  if (!parent.has(x)) parent.set(x, x);
  const p = parent.get(x)!;
  if (p !== x) {
    const r = find(p);
    parent.set(x, r);
    return r;
  }
  return x;
}
function union(a: string, b: string) {
  const ra = find(a);
  const rb = find(b);
  if (ra === rb) return;
  if (ra < rb) parent.set(rb, ra);
  else parent.set(ra, rb);
}

for (const p of pairs) union(p.ticker_a, p.ticker_b);

const companies = (
  db.prepare(`SELECT DISTINCT ticker FROM board_seats`).all() as Array<{ ticker: string }>
).map((r) => r.ticker);
for (const t of companies) find(t);

const comps = new Map<string, string[]>();
for (const t of companies) {
  const r = find(t);
  const m = comps.get(r);
  if (m) m.push(t);
  else comps.set(r, [t]);
}
for (const m of comps.values()) m.sort();

const clusters = [...comps.entries()].filter(([, m]) => m.length >= 2);
const isolated = [...comps.values()].filter((m) => m.length === 1).length;
const clustered = clusters.flatMap(([, m]) => m);
const clusteredJson = JSON.stringify(clustered);

const clusteredDirs = clustered.length
  ? (db
      .prepare(
        `SELECT COUNT(DISTINCT s.person_id) AS n
         FROM board_seats s
         WHERE s.ticker IN (SELECT value FROM json_each(?))`,
      )
      .get(clusteredJson) as { n: number })
  : { n: 0 };
const clusteredGroups = clustered.length
  ? (db
      .prepare(
        `SELECT COUNT(DISTINCT g.group_key) AS n
         FROM company_groups g
         WHERE g.ticker IN (SELECT value FROM json_each(?))`,
      )
      .get(clusteredJson) as { n: number })
  : { n: 0 };

function bucket(min: number) {
  return clusters.filter(([, m]) => m.length >= min).length;
}
function cosIn(min: number) {
  return clusters.filter(([, m]) => m.length >= min).reduce((n, [, m]) => n + m.length, 0);
}
function dirsIn(min: number) {
  const ts = clusters.filter(([, m]) => m.length >= min).flatMap(([, m]) => m);
  if (!ts.length) return 0;
  return (
    db
      .prepare(
        `SELECT COUNT(DISTINCT s.person_id) AS n
         FROM board_seats s
         WHERE s.ticker IN (SELECT value FROM json_each(?))`,
      )
      .get(JSON.stringify(ts)) as { n: number }
  ).n;
}

let largestCos = { key: "", n: 0 };
for (const [, m] of clusters) {
  if (m.length > largestCos.n) largestCos = { key: m[0], n: m.length };
}

let largestDirs = { key: "", n: 0 };
const dirCount = db.prepare(
  `SELECT COUNT(DISTINCT s.person_id) AS n
   FROM board_seats s WHERE s.ticker IN (SELECT value FROM json_each(?))`,
);
for (const [, m] of clusters) {
  const n = (dirCount.get(JSON.stringify(m)) as { n: number }).n;
  if (n > largestDirs.n) largestDirs = { key: m[0], n };
}

const out = {
  seats,
  unique_pairs: pairStats.unique_pairs,
  duplicate_pairs: dups,
  self_pairs: pairStats.self_pairs,
  components: comps.size,
  clusters_2plus: clusters.length,
  isolated,
  companies_in_clusters: clustered.length,
  directors_in_clusters: clusteredDirs.n,
  groups_in_clusters: clusteredGroups.n,
  cross_group_pairs: pairStats.cross_group_pairs,
  multi_director_pairs: pairStats.multi_director_pairs,
  largest_cluster_companies: largestCos,
  largest_cluster_directors: largestDirs,
  dist_clusters: {
    c2: bucket(2),
    c3: bucket(3),
    c5: bucket(5),
    c10: bucket(10),
    c20: bucket(20),
    c50: bucket(50),
    c100: bucket(100),
  },
  dist_companies: { c2: cosIn(2), c5: cosIn(5), c10: cosIn(10) },
  dist_directors: { c2: dirsIn(2), c5: dirsIn(5), c10: dirsIn(10) },
};
db.close();
console.log(JSON.stringify(out, null, 2));
