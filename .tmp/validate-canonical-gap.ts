import { loadNewConnections } from "../src/lib/company-network";
import { openSqliteNamed } from "../src/lib/sqlite-utils";

function allEdges() {
  const first = loadNewConnections({
    days: 180,
    maxTargetMcap: 5000,
    includeFormerSeats: false,
    page: 1,
    pageSize: 200,
  });
  const rows = [...first.rows];
  for (let p = 2; p <= first.pages; p++) {
    rows.push(
      ...loadNewConnections({
        days: 180,
        maxTargetMcap: 5000,
        includeFormerSeats: false,
        page: p,
        pageSize: 200,
      }).rows,
    );
  }
  return { first, rows };
}

const { first, rows } = allEdges();
const triples = rows.map(
  (r) => `${r.target_ticker}|${r.person_id}|${r.connected_ticker}`,
);
const dup = triples.length - new Set(triples).size;
const former = rows.filter((r) => r.connected_current === 0).length;
const mcapOk = rows.every(
  (r) =>
    r.target_market_cap != null &&
    r.target_market_cap > 0 &&
    r.target_market_cap < 5000 &&
    r.connected_market_cap != null &&
    r.connected_market_cap > 0,
);

const byTarget = new Map<string, typeof rows>();
for (const r of rows) {
  const k = r.target_ticker;
  if (!byTarget.has(k)) byTarget.set(k, []);
  byTarget.get(k)!.push(r);
}
let with1_10k = 0;
let with2_10k = 0;
for (const edges of byTarget.values()) {
  const n = new Set(
    edges
      .filter((e) => (e.connected_market_cap ?? 0) >= 10000)
      .map((e) => e.connected_ticker),
  ).size;
  if (n >= 1) with1_10k++;
  if (n >= 2) with2_10k++;
}

const max = rows.reduce(
  (a, r) =>
    (r.market_cap_ratio ?? -1) > (a.market_cap_ratio ?? -1) ? r : a,
  rows[0],
);

const n10 = rows.filter((r) => (r.connected_market_cap ?? 0) >= 10000).length;
const n25 = rows.filter((r) => (r.connected_market_cap ?? 0) >= 25000).length;
const n50 = rows.filter((r) => (r.connected_market_cap ?? 0) >= 50000).length;

const db = openSqliteNamed("governance.db", { wal: true, readonly: true });

const notCurrentSeat = rows.filter((r) => {
  const n = db
    .prepare(
      `SELECT COUNT(*) AS n FROM board_seats WHERE ticker=? AND person_id=?`,
    )
    .get(r.connected_ticker, r.person_id) as { n: number };
  return n.n === 0;
}).length;

const notOnTarget = rows.filter((r) => {
  const n = db
    .prepare(
      `SELECT COUNT(*) AS n FROM board_seats WHERE ticker=? AND person_id=?`,
    )
    .get(r.target_ticker, r.person_id) as { n: number };
  return n.n === 0;
}).length;

db.close();

console.log(
  JSON.stringify(
    {
      edges: first.total,
      unique_targets: first.summary.unique_targets,
      unique_directors: first.summary.unique_directors,
      cross_group: first.summary.cross_group,
      mega_50k: first.summary.mega_connections,
      n10k_edges: n10,
      n25k_edges: n25,
      n50k_edges: n50,
      targets_with_1_10k: with1_10k,
      targets_with_2_10k: with2_10k,
      duplicate_triples: dup,
      former_rows: former,
      connected_not_current_seat: notCurrentSeat,
      target_not_current_seat: notOnTarget,
      mcap_ok: mcapOk,
      max_ratio: max?.market_cap_ratio,
      max_target: max?.target_ticker,
      max_target_company: max?.target_company,
      max_connected: max?.connected_ticker,
      max_connected_company: max?.connected_company,
      max_target_mcap: max?.target_market_cap,
      max_connected_mcap: max?.connected_market_cap,
    },
    null,
    2,
  ),
);
