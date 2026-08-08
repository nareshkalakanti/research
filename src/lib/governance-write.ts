/**
 * Writable governance.db helpers — upsert only (never wipe the DB).
 * Per-ticker seat replace is intentional; other companies stay intact.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { normDin, type BoardSeat } from "./nse-governance";

const DATA_DIR = path.join(process.cwd(), "data");
const GOV_PATH = path.join(DATA_DIR, "governance.db");

let writeDb: Database.Database | null = null;

function utcNow(): string {
  return new Date().toISOString();
}

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function nameKey(name: string): string {
  let text = safeStr(name).toLowerCase();
  text = text.replace(/\b(mr|mrs|ms|dr|shri|smt)\.?\b/g, " ");
  text = text.replace(/[^a-z0-9]+/g, " ");
  return text.split(/\s+/).filter(Boolean).join(" ");
}

export function personIdFor(opts: {
  din?: string | null;
  name?: string | null;
}): string {
  const din = normDin(opts.din);
  if (din && din.length === 8) return din;
  const key = nameKey(opts.name || "");
  if (!key) throw new Error("Director needs a DIN or a name");
  return `n:${key}`;
}

function requireMarket(market: string | null | undefined): string {
  const m = safeStr(market).toUpperCase() || "NSE";
  if (m !== "NSE" && m !== "NSE SME") {
    throw new Error("Governance is NSE-only");
  }
  return m;
}

function inferCategory(designation: string): string {
  const text = designation.toLowerCase();
  if (text.includes("independent")) return "Independent";
  if (
    ["managing", "executive", "whole-time", "whole time", "ceo", "cfo", "cto"].some(
      (x) => text.includes(x),
    )
  ) {
    return "Executive";
  }
  if (text.includes("non-executive") || text.includes("non executive")) {
    return "Non-Executive";
  }
  return "";
}

export function getGovernanceWriteDb(): Database.Database {
  if (writeDb) return writeDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(GOV_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      ticker TEXT PRIMARY KEY,
      market TEXT NOT NULL DEFAULT 'NSE'
        CHECK (market IN ('NSE', 'NSE SME', 'BSE')),
      name TEXT NOT NULL,
      cin TEXT,
      isin TEXT,
      notes TEXT,
      sector TEXT,
      industry TEXT,
      sub_sector TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS directors (
      person_id TEXT PRIMARY KEY,
      din TEXT UNIQUE,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_seats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES directors(person_id) ON DELETE CASCADE,
      designation TEXT NOT NULL,
      category TEXT,
      source TEXT NOT NULL,
      as_of TEXT,
      fetched_at TEXT NOT NULL,
      UNIQUE (ticker, person_id)
    );
    CREATE TABLE IF NOT EXISTS scan_log (
      ticker TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      detail TEXT,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gov_seats_person ON board_seats(person_id);
    CREATE INDEX IF NOT EXISTS idx_gov_seats_ticker ON board_seats(ticker);
  `);
  writeDb = db;
  return db;
}

export function tickerHasDinBoard(ticker: string): boolean {
  const key = safeStr(ticker).toUpperCase();
  const row = getGovernanceWriteDb()
    .prepare(
      `
      SELECT 1
      FROM board_seats s
      JOIN directors d ON d.person_id = s.person_id
      WHERE s.ticker = ? AND d.din IS NOT NULL AND TRIM(d.din) != ''
      LIMIT 1
      `,
    )
    .get(key);
  return Boolean(row);
}

export type IdentitySnapshot = {
  personIds: Set<string>;
  dins: Set<string>;
  seats: Set<string>; // ticker|person_id
};

export function snapshotIdentities(): IdentitySnapshot {
  const db = getGovernanceWriteDb();
  const personIds = new Set<string>();
  const dins = new Set<string>();
  const seats = new Set<string>();

  for (const r of db
    .prepare(`SELECT person_id, din FROM directors`)
    .all() as Array<{ person_id: string; din: string | null }>) {
    personIds.add(r.person_id);
    if (r.din?.trim()) dins.add(r.din.trim());
  }
  for (const r of db
    .prepare(`SELECT ticker, person_id FROM board_seats`)
    .all() as Array<{ ticker: string; person_id: string }>) {
    seats.add(`${r.ticker.toUpperCase()}|${r.person_id}`);
  }
  return { personIds, dins, seats };
}

export type NewIdentity = {
  person_id: string;
  din: string | null;
  name: string;
};

export function diffIdentities(before: IdentitySnapshot): {
  newDins: string[];
  newDirectors: NewIdentity[];
  newSeats: number;
} {
  const db = getGovernanceWriteDb();
  const newDins: string[] = [];
  const newDirectors: NewIdentity[] = [];

  for (const r of db
    .prepare(`SELECT person_id, din, name FROM directors`)
    .all() as Array<{ person_id: string; din: string | null; name: string }>) {
    const din = r.din?.trim() || null;
    const isNewPerson = !before.personIds.has(r.person_id);
    const isNewDin = Boolean(din && !before.dins.has(din));
    if (isNewDin && din) newDins.push(din);
    if (isNewPerson || isNewDin) {
      newDirectors.push({
        person_id: r.person_id,
        din,
        name: r.name,
      });
    }
  }

  let newSeats = 0;
  for (const r of db
    .prepare(`SELECT ticker, person_id FROM board_seats`)
    .all() as Array<{ ticker: string; person_id: string }>) {
    const key = `${r.ticker.toUpperCase()}|${r.person_id}`;
    if (!before.seats.has(key)) newSeats += 1;
  }

  // Deduplicate directors by person_id
  const seen = new Set<string>();
  const uniqueDirectors = newDirectors.filter((d) => {
    if (seen.has(d.person_id)) return false;
    seen.add(d.person_id);
    return true;
  });

  return {
    newDins: [...new Set(newDins)],
    newDirectors: uniqueDirectors,
    newSeats,
  };
}

export type SaveBoardResult = {
  ticker: string;
  seats: number;
  skipped: boolean;
  reason?: string;
};

export function saveCompanyBoard(opts: {
  ticker: string;
  name: string;
  seats: BoardSeat[];
  market?: string;
  notes?: string | null;
  replaceSeats?: boolean;
  protectDinBoard?: boolean;
}): SaveBoardResult {
  const tickerKey = safeStr(opts.ticker).toUpperCase();
  if (!tickerKey) throw new Error("ticker required");
  const companyName = safeStr(opts.name);
  if (!companyName) throw new Error("company name required");
  const market = requireMarket(opts.market);

  const cleanSeats: Array<{
    person_id: string;
    din: string;
    name: string;
    designation: string;
    category: string;
    source: string;
    as_of: string;
  }> = [];

  for (const raw of opts.seats) {
    const person = safeStr(raw.name);
    const designation = safeStr(raw.designation) || "Director";
    const din = normDin(raw.din);
    if (!person) throw new Error("Director name required");
    if (din && din.length !== 8) {
      throw new Error(`Invalid DIN for ${person}: ${raw.din}`);
    }
    const pid = personIdFor({ din: din || null, name: person });
    const category =
      safeStr(raw.category) || inferCategory(designation);
    cleanSeats.push({
      person_id: pid,
      din,
      name: person,
      designation,
      category,
      source: safeStr(raw.source) || "nse_governance",
      as_of: safeStr(raw.as_of),
    });
  }

  if (!cleanSeats.length) throw new Error("At least one director seat required");

  const newHasDin = cleanSeats.some((s) => s.din);
  const protect = opts.protectDinBoard !== false;
  if (protect && !newHasDin && tickerHasDinBoard(tickerKey)) {
    return {
      ticker: tickerKey,
      seats: 0,
      skipped: true,
      reason: "Kept curated DIN board (scan had no DINs)",
    };
  }

  const now = utcNow();
  const db = getGovernanceWriteDb();
  const replaceSeats = opts.replaceSeats !== false;

  const tx = db.transaction(() => {
    db.prepare(
      `
      INSERT INTO companies (
        ticker, market, name, cin, isin, notes,
        sector, industry, sub_sector, updated_at
      )
      VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        market=excluded.market,
        name=excluded.name,
        notes=COALESCE(NULLIF(excluded.notes, ''), companies.notes),
        updated_at=excluded.updated_at
      `,
    ).run(tickerKey, market, companyName, safeStr(opts.notes) || null, now);

    if (replaceSeats) {
      db.prepare(`DELETE FROM board_seats WHERE ticker = ?`).run(tickerKey);
    }

    const upsertDir = db.prepare(
      `
      INSERT INTO directors (person_id, din, name, name_key, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(person_id) DO UPDATE SET
        din=COALESCE(NULLIF(excluded.din, ''), directors.din),
        name=excluded.name,
        name_key=excluded.name_key,
        updated_at=excluded.updated_at
      `,
    );
    const upsertSeat = db.prepare(
      `
      INSERT INTO board_seats (
        ticker, person_id, designation, category, source, as_of, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker, person_id) DO UPDATE SET
        designation=excluded.designation,
        category=excluded.category,
        source=excluded.source,
        as_of=excluded.as_of,
        fetched_at=excluded.fetched_at
      `,
    );

    for (const seat of cleanSeats) {
      upsertDir.run(
        seat.person_id,
        seat.din || null,
        seat.name,
        nameKey(seat.name),
        now,
      );
      upsertSeat.run(
        tickerKey,
        seat.person_id,
        seat.designation,
        seat.category || null,
        seat.source,
        seat.as_of || null,
        now,
      );
    }
  });

  tx();
  return { ticker: tickerKey, seats: cleanSeats.length, skipped: false };
}

export function recordScanAttempt(
  ticker: string,
  status: string,
  detail?: string | null,
): void {
  const key = safeStr(ticker).toUpperCase();
  if (!key) return;
  getGovernanceWriteDb()
    .prepare(
      `
      INSERT INTO scan_log (ticker, status, detail, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        status=excluded.status,
        detail=excluded.detail,
        fetched_at=excluded.fetched_at
      `,
    )
    .run(key, safeStr(status) || "failed", safeStr(detail) || null, utcNow());
}

export function scannedTickerSet(): Set<string> {
  const rows = getGovernanceWriteDb()
    .prepare(`SELECT ticker FROM scan_log`)
    .all() as Array<{ ticker: string }>;
  return new Set(rows.map((r) => r.ticker.toUpperCase()).filter(Boolean));
}

export function dinBoardTickerSet(): Set<string> {
  const rows = getGovernanceWriteDb()
    .prepare(
      `
      SELECT DISTINCT s.ticker
      FROM board_seats s
      JOIN directors d ON d.person_id = s.person_id
      WHERE d.din IS NOT NULL AND TRIM(d.din) != ''
      `,
    )
    .all() as Array<{ ticker: string }>;
  return new Set(rows.map((r) => r.ticker.toUpperCase()));
}
