/**
 * Board independence from this company's seats (not other-board reputation).
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { DATA_DIR } from "./sqlite-utils";

export type BoardIndependence = {
  ticker: string;
  name: string;
  market: string;
  total: number;
  independent: number;
  pct: number;
  family_control: boolean;
  /** ≥50% independent and no promoter-family on control seats. */
  qualifies: boolean;
};

/** Share floors for the ranked independence view (percent of board). */
export const INDEPENDENCE_FLOORS = [50, 60, 70, 80] as const;

const ROLE_SURNAME = new Set([
  "DIRECTOR",
  "CHAIRMAN",
  "CHAIRPERSON",
  "INDEPENDENT",
  "EXECUTIVE",
  "MANAGING",
  "LIMITED",
  "SECRETARY",
  "NOMINEE",
  "PROMOTER",
]);

function seatText(designation: string, category: string | null): string {
  return `${designation} ${category || ""}`.toLowerCase();
}

export function seatIsIndependent(
  designation: string,
  category: string | null,
): boolean {
  const text = seatText(designation, category);
  if (/non[-\s]?independent/.test(text)) return false;
  return /\bindependent\b/.test(text);
}

export function seatIsControl(
  designation: string,
  category: string | null,
): boolean {
  if (seatIsIndependent(designation, category)) return false;
  const text = seatText(designation, category);
  if (/nominee/.test(text)) return false;
  return /promoter|founder|chair|managing|whole[-\s]?time|\bceo\b|\bmd\b/.test(
    text,
  );
}

function normalizedSurname(name: string): string {
  const bits = name
    .replace(/\b(mr|mrs|ms|dr|shri|smt)\.?\b/gi, " ")
    .replace(/[().,]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const last = (bits[bits.length - 1] || "").toUpperCase();
  if (last.length < 3 || ROLE_SURNAME.has(last)) return "";
  return last;
}

export function scoreBoardIndependence(
  seats: Array<{
    name: string;
    designation: string;
    category: string | null;
  }>,
): Omit<BoardIndependence, "ticker" | "name" | "market"> {
  const total = seats.length;
  const independent = seats.filter((s) =>
    seatIsIndependent(s.designation, s.category),
  ).length;
  const pct = total ? independent / total : 0;
  const control = seats.filter((s) =>
    seatIsControl(s.designation, s.category),
  );
  const surnameCounts = new Map<string, number>();
  for (const s of control) {
    const n = normalizedSurname(s.name);
    if (!n) continue;
    surnameCounts.set(n, (surnameCounts.get(n) ?? 0) + 1);
  }
  const family_control = [...surnameCounts.values()].some((n) => n >= 2);
  const qualifies = total >= 2 && pct >= 0.5 && !family_control;
  return {
    total,
    independent,
    pct,
    family_control,
    qualifies,
  };
}

type Cache = { at: number; byTicker: Map<string, BoardIndependence> };
let cache: Cache | null = null;
const CACHE_MS = 60_000;

function loadAll(): Map<string, BoardIndependence> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.byTicker;
  const govPath = path.join(DATA_DIR, "governance.db");
  const byTicker = new Map<string, BoardIndependence>();
  if (!fs.existsSync(govPath)) {
    cache = { at: now, byTicker };
    return byTicker;
  }
  const db = new Database(govPath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  try {
    const rows = db
      .prepare(
        `SELECT s.ticker, c.name AS company_name, c.market,
                d.name AS director_name, s.designation, s.category
         FROM board_seats s
         JOIN directors d ON d.person_id = s.person_id
         JOIN companies c ON c.ticker = s.ticker
         WHERE UPPER(c.market) IN ('NSE', 'NSE SME', 'BSE', 'BSE SME')`,
      )
      .all() as Array<{
      ticker: string;
      company_name: string;
      market: string;
      director_name: string;
      designation: string;
      category: string | null;
    }>;
    const grouped = new Map<
      string,
      {
        name: string;
        market: string;
        seats: Array<{ name: string; designation: string; category: string | null }>;
      }
    >();
    for (const row of rows) {
      const ticker = (row.ticker || "").toUpperCase();
      if (!ticker) continue;
      const cur = grouped.get(ticker) ?? {
        name: row.company_name || ticker,
        market: row.market || "",
        seats: [],
      };
      cur.seats.push({
        name: row.director_name || "",
        designation: row.designation || "",
        category: row.category,
      });
      grouped.set(ticker, cur);
    }
    for (const [ticker, g] of grouped) {
      const scored = scoreBoardIndependence(g.seats);
      byTicker.set(ticker, {
        ticker,
        name: g.name,
        market: g.market,
        ...scored,
      });
    }
  } finally {
    db.close();
  }
  cache = { at: now, byTicker };
  return byTicker;
}

export function boardIndependenceForTicker(
  ticker: string,
): BoardIndependence | null {
  return loadAll().get(ticker.trim().toUpperCase()) || null;
}

export function independentBoardTickerSet(): Set<string> {
  const out = new Set<string>();
  for (const row of loadAll().values()) {
    if (row.qualifies) out.add(row.ticker);
  }
  return out;
}

export function independentBoardCount(): number {
  return independentBoardTickerSet().size;
}

export function independenceFloorCounts(noFamily: boolean): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const floor of INDEPENDENCE_FLOORS) counts[floor] = 0;
  for (const row of loadAll().values()) {
    if (row.total < 2) continue;
    if (noFamily && row.family_control) continue;
    const pct = Math.round(row.pct * 100);
    for (const floor of INDEPENDENCE_FLOORS) {
      if (pct >= floor) counts[floor] += 1;
    }
  }
  return counts;
}

function compareIndependenceRank(a: BoardIndependence, b: BoardIndependence): number {
  if (b.pct !== a.pct) return b.pct - a.pct;
  if (b.independent !== a.independent) return b.independent - a.independent;
  if (a.family_control !== b.family_control) return a.family_control ? 1 : -1;
  if (b.total !== a.total) return b.total - a.total;
  return a.ticker.localeCompare(b.ticker);
}

export function rankedBoardIndependence(opts: {
  minPct: number;
  noFamily: boolean;
  q?: string;
}): BoardIndependence[] {
  const needle = (opts.q || "").trim().toLowerCase();
  const min = Number.isFinite(opts.minPct) ? opts.minPct : 0;
  const out: BoardIndependence[] = [];
  for (const row of loadAll().values()) {
    if (row.total < 2) continue;
    if (opts.noFamily && row.family_control) continue;
    if (row.pct * 100 < min) continue;
    if (needle) {
      const hay = `${row.ticker} ${row.name}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    out.push(row);
  }
  out.sort(compareIndependenceRank);
  return out;
}

export type IndependenceSeat = {
  person_id: string;
  name: string;
  din: string | null;
  din_backed: boolean;
  designation: string;
  category: string | null;
  independent: boolean;
};

export function independenceSeatsForTickers(
  tickers: string[],
): Map<string, IndependenceSeat[]> {
  const out = new Map<string, IndependenceSeat[]>();
  const want = new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean));
  if (!want.size) return out;
  const govPath = path.join(DATA_DIR, "governance.db");
  if (!fs.existsSync(govPath)) return out;
  const db = new Database(govPath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  try {
    const tickerList = [...want];
    const placeholders = tickerList.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT s.ticker, s.person_id, d.name, d.din, s.designation, s.category
         FROM board_seats s
         JOIN directors d ON d.person_id = s.person_id
         WHERE UPPER(s.ticker) IN (${placeholders})`,
      )
      .all(...tickerList) as Array<{
      ticker: string;
      person_id: string;
      name: string;
      din: string | null;
      designation: string;
      category: string | null;
    }>;
    for (const row of rows) {
      const ticker = (row.ticker || "").toUpperCase();
      const list = out.get(ticker) ?? [];
      const din = (row.din || "").replace(/\D/g, "");
      list.push({
        person_id: row.person_id,
        name: row.name || "",
        din: din.length === 8 ? din : row.din,
        din_backed: din.length === 8,
        designation: row.designation || "",
        category: row.category,
        independent: seatIsIndependent(row.designation || "", row.category),
      });
      out.set(ticker, list);
    }
  } finally {
    db.close();
  }
  return out;
}

export function invalidateBoardIndependenceCache(): void {
  cache = null;
}
