import { loadNewConnections } from "../src/lib/company-network";
import { openSqliteNamed } from "../src/lib/sqlite-utils";

function key(r: {
  target_ticker: string;
  person_id: string;
  connected_ticker: string;
}) {
  return `${r.target_ticker}|${r.person_id}|${r.connected_ticker}`;
}

function day(iso: string | null | undefined) {
  if (!iso) return null;
  return iso.slice(0, 10);
}

function allRows(opts: Parameters<typeof loadNewConnections>[0]) {
  const first = loadNewConnections({ ...opts, page: 1, pageSize: 200 });
  const rows = [...first.rows];
  for (let p = 2; p <= first.pages; p++) {
    rows.push(
      ...loadNewConnections({ ...opts, page: p, pageSize: 200 }).rows,
    );
  }
  return { ...first, rows };
}

function dump(r: any) {
  return {
    director: r.director,
    existing: r.connected_ticker,
    neu: r.target_ticker,
    existing_join: r.connected_joined_at,
    new_join: r.event_date,
    existing_day: day(r.connected_joined_at),
    new_day: day(r.event_date),
    resigned: r.connected_current === 0 ? r.connected_resigned_at : "Current",
    ratio: r.market_cap_ratio,
    type: r.connection_type,
    existing_mcap: r.connected_market_cap,
    new_mcap: r.target_market_cap,
  };
}

const canonical = allRows({
  days: 180,
  maxTargetMcap: 5000,
  includeFormerSeats: false,
});
const currentNoFormer = allRows({
  days: 180,
  maxTargetMcap: null,
  includeFormerSeats: false,
});
const current = allRows({
  days: 180,
  maxTargetMcap: null,
  includeFormerSeats: true,
});

const canonKeys = new Set(canonical.rows.map(key));
const noFormerKeys = new Set(currentNoFormer.rows.map(key));

const formerOnly = current.rows.filter((r) => !noFormerKeys.has(key(r)));
const fromMcapLift = currentNoFormer.rows.filter((r) => !canonKeys.has(key(r)));
const stillCanonical = current.rows.filter((r) => canonKeys.has(key(r)));

const counts = new Map<string, number>();
for (const r of current.rows) {
  const k = key(r);
  counts.set(k, (counts.get(k) || 0) + 1);
}
const duplicateTriples = current.rows.filter((r) => (counts.get(key(r)) || 0) > 1);

const sameTimestamp = current.rows.filter(
  (r) => r.connected_joined_at && r.event_date && r.connected_joined_at === r.event_date,
);
const sameDay = current.rows.filter((r) => {
  const a = day(r.connected_joined_at);
  const b = day(r.event_date);
  return a != null && b != null && a === b;
});
const existingLater = current.rows.filter((r) => {
  const a = day(r.connected_joined_at);
  const b = day(r.event_date);
  return a != null && b != null && a > b;
});
const existingEarlier = current.rows.filter((r) => {
  const a = day(r.connected_joined_at);
  const b = day(r.event_date);
  if (b == null) return false;
  if (a == null) return true;
  return a < b;
});
const existingUnknownJoin = current.rows.filter((r) => !r.connected_joined_at);

const reversePairs = current.rows.filter((r) =>
  current.rows.some(
    (o) =>
      o.person_id === r.person_id &&
      o.target_ticker === r.connected_ticker &&
      o.connected_ticker === r.target_ticker,
  ),
);

const directed = existingEarlier;
const unknown = current.rows.filter((r) => !existingEarlier.includes(r));

const kali = current.rows.filter(
  (r) =>
    String(r.director).toUpperCase().includes("KALI") ||
    (r.target_ticker === "MANAKSTEEL" && r.connected_ticker === "MANAKSIA") ||
    (r.target_ticker === "MANAKSIA" && r.connected_ticker === "MANAKSTEEL"),
);

console.log(
  JSON.stringify(
    {
      totals: {
        canonical_former0_max5000: canonical.total,
        current_former0_allMcap: currentNoFormer.total,
        current_former1_allMcap: current.total,
        canonical_in_current: stillCanonical.length,
        extra_from_mcap_all: fromMcapLift.length,
        extra_from_former: formerOnly.length,
        extra_other:
          current.total -
          canonical.total -
          fromMcapLift.length -
          formerOnly.length,
      },
      buckets: {
        duplicate_triple_rows: duplicateTriples.length,
        unique_duplicate_triples: new Set(duplicateTriples.map(key)).size,
        same_join_timestamp: sameTimestamp.length,
        same_join_calendar_day: sameDay.length,
        existing_join_unknown_pretracking: existingUnknownJoin.length,
        existing_join_strictly_earlier: existingEarlier.length,
        existing_join_strictly_later: existingLater.length,
        reverse_pair_rows: reversePairs.length,
        reverse_pair_people: new Set(reversePairs.map((r) => r.person_id)).size,
        direction_evidence: directed.length,
        direction_unknown: unknown.length,
      },
    },
    null,
    2,
  ),
);

console.log("\n=== FORMER-ONLY ===");
console.log(JSON.stringify(formerOnly.map(dump), null, 2));

console.log("\n=== DUPLICATE TRIPLES ===");
console.log(JSON.stringify(duplicateTriples.map(dump), null, 2));

console.log("\n=== KALI / MANAKSIA / MANAKSTEEL ===");
console.log(JSON.stringify(kali.map(dump), null, 2));

const db = openSqliteNamed("governance.db", { wal: true, readonly: true });
const kaliEvents = db
  .prepare(
    `SELECT e.ticker, e.person_id, e.director_name, e.event_type, e.detected_at, e.old_designation, e.new_designation, e.id
     FROM board_seat_events e
     WHERE e.person_id IN (
       SELECT person_id FROM board_seat_events
       WHERE ticker IN ('MANAKSIA','MANAKSTEEL')
         AND director_name LIKE '%KALI%'
     )
        OR (e.ticker IN ('MANAKSIA','MANAKSTEEL') AND e.director_name LIKE '%KALI%')
     ORDER BY e.detected_at, e.id`,
  )
  .all();
console.log("\n=== KALI EVENTS ===");
console.log(JSON.stringify(kaliEvents, null, 2));

const sameDaySample = sameDay.slice(0, 20);
console.log("\n=== 20 SAME-DAY ROWS ===");
console.log(JSON.stringify(sameDaySample.map(dump), null, 2));

const unknownNotSameDay = unknown.filter((r) => {
  const a = day(r.connected_joined_at);
  const b = day(r.event_date);
  return !(a != null && b != null && a === b);
});
console.log("\n=== UNKNOWN BUT NOT SAME DAY ===");
console.log(JSON.stringify(unknownNotSameDay.map(dump), null, 2));

const mcapSample = fromMcapLift.slice(0, 10);
console.log("\n=== 10 MCAP-LIFT SAMPLE ===");
console.log(JSON.stringify(mcapSample.map(dump), null, 2));

const reverseSample = reversePairs.slice(0, 20);
console.log("\n=== 20 REVERSE-PAIR ROWS ===");
console.log(JSON.stringify(reverseSample.map(dump), null, 2));

const laterSample = existingLater.slice(0, 10);
console.log("\n=== EXISTING JOIN LATER THAN NEW ===");
console.log(JSON.stringify(laterSample.map(dump), null, 2));

db.close();
