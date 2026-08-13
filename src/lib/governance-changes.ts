import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { loadMetricsMap } from "./metrics";
import { mcapCapCode } from "./gov-score";
import { isWatchedPerson, loadGovWatch } from "./governance-watch";

const DATA_DIR = path.join(process.cwd(), "data");

export type SeatEventType = "joined" | "resigned" | "role_changed";

export type BoardSeatEvent = {
  id: number;
  ticker: string;
  company_name: string | null;
  person_id: string;
  director_name: string;
  din: string | null;
  event_type: SeatEventType;
  old_designation: string | null;
  new_designation: string | null;
  old_category: string | null;
  new_category: string | null;
  source: string | null;
  as_of: string | null;
  detected_at: string;
  watched: boolean;
  market_cap_cr: number | null;
  cap_code: string | null;
};

function openGovDb(): Database.Database | null {
  const dbPath = path.join(DATA_DIR, "governance.db");
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

export function listRecentSeatEvents(opts?: {
  limit?: number;
  watchOnly?: boolean;
  personId?: string | null;
  ticker?: string | null;
}): BoardSeatEvent[] {
  const db = openGovDb();
  if (!db) return [];

  const limit = Math.min(200, Math.max(1, opts?.limit ?? 40));
  const watchOnly = opts?.watchOnly === true;
  const personId = opts?.personId?.trim() || null;
  const ticker = opts?.ticker?.trim().toUpperCase() || null;

  let sql = `
    SELECT
      e.id,
      e.ticker,
      c.name AS company_name,
      e.person_id,
      e.director_name,
      e.din,
      e.event_type,
      e.old_designation,
      e.new_designation,
      e.old_category,
      e.new_category,
      e.source,
      e.as_of,
      e.detected_at
    FROM board_seat_events e
    LEFT JOIN companies c ON c.ticker = e.ticker
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (personId) {
    sql += ` AND e.person_id = ?`;
    params.push(personId);
  }
  if (ticker) {
    sql += ` AND e.ticker = ?`;
    params.push(ticker);
  }
  if (watchOnly) {
    const watch = loadGovWatch();
    const ids = [
      ...new Set(
        watch.flatMap((w) => [w.person_id, w.din].filter(Boolean) as string[]),
      ),
    ];
    if (!ids.length) return [];
    sql += ` AND e.person_id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids);
  }

  sql += ` ORDER BY e.detected_at DESC, e.id DESC LIMIT ?`;
  params.push(limit);

  const metrics = loadMetricsMap();
  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    ticker: string;
    company_name: string | null;
    person_id: string;
    director_name: string;
    din: string | null;
    event_type: SeatEventType;
    old_designation: string | null;
    new_designation: string | null;
    old_category: string | null;
    new_category: string | null;
    source: string | null;
    as_of: string | null;
    detected_at: string;
  }>;

  return rows.map((r) => {
    const m = metrics.get(r.ticker.toUpperCase());
    const mcap = m?.market_cap_cr ?? null;
    return {
      ...r,
      watched: isWatchedPerson(r.person_id, r.din),
      market_cap_cr: mcap,
      cap_code: mcapCapCode(mcap),
    };
  });
}

export function seatEventSummary(events: BoardSeatEvent[]): {
  joined: number;
  resigned: number;
  role_changed: number;
  watched: number;
} {
  let joined = 0;
  let resigned = 0;
  let role_changed = 0;
  let watched = 0;
  for (const e of events) {
    if (e.event_type === "joined") joined += 1;
    if (e.event_type === "resigned") resigned += 1;
    if (e.event_type === "role_changed") role_changed += 1;
    if (e.watched) watched += 1;
  }
  return { joined, resigned, role_changed, watched };
}
