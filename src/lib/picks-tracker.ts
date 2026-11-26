import { openSqliteNamed } from "./sqlite-utils";
import { masterLabels } from "./stock-master";

/**
 * Picks tracker: stocks the user enters per source (e.g. Niveshaay) per quarter, nothing pulled.
 * Saved in data/picks_tracker.db. Sector / industry come from the stock master at read time.
 */

/** Quarter key "2026-Q1" (Jan–Mar). */
export type QuarterKey = `${number}-Q${1 | 2 | 3 | 4}`;

export type Pick = {
  source: string;
  quarter: string;
  ticker: string;
  market: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  added_at: string;
};

export type PicksData = { sources: string[]; picks: Pick[] };

function db() {
  const d = openSqliteNamed("picks_tracker.db", { readonly: false, wal: true });
  d.pragma("busy_timeout = 5000");
  d.exec(`CREATE TABLE IF NOT EXISTS sources (
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS picks (
      source TEXT NOT NULL,
      quarter TEXT NOT NULL,
      ticker TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'NSE',
      name TEXT,
      added_at TEXT NOT NULL,
      PRIMARY KEY (source, quarter, ticker)
    );`);
  return d;
}

const QUARTER_RE = /^\d{4}-Q[1-4]$/;
const clean = (s: unknown, max = 80) => (typeof s === "string" ? s.trim().slice(0, max) : "");

export function readPicks(): PicksData {
  const d = db();
  try {
    const labels = masterLabels();
    const sources = (d.prepare("SELECT name FROM sources ORDER BY created_at").all() as Array<{ name: string }>).map((r) => r.name);
    const picks = (
      d.prepare("SELECT source, quarter, ticker, market, name, added_at FROM picks ORDER BY quarter, source, added_at").all() as Array<
        Omit<Pick, "sector" | "industry">
      >
    ).map((p) => {
      const lab = labels.get(p.ticker.toUpperCase());
      return { ...p, sector: lab?.sector ?? null, industry: lab?.industry ?? null };
    });
    return { sources, picks };
  } finally {
    d.close();
  }
}

export function addSource(name: string): void {
  const n = clean(name, 60);
  if (!n) throw new Error("Source name needed");
  const d = db();
  try {
    d.prepare("INSERT OR IGNORE INTO sources (name, created_at) VALUES (?, ?)").run(n, new Date().toISOString());
  } finally {
    d.close();
  }
}

export function addPick(p: { source: string; quarter: string; ticker: string; market?: string; name?: string }): void {
  const source = clean(p.source, 60);
  const quarter = clean(p.quarter, 7);
  const ticker = clean(p.ticker, 30).toUpperCase();
  if (!source || !ticker || !QUARTER_RE.test(quarter)) throw new Error("source, quarter (YYYY-Qn) and ticker needed");
  const d = db();
  try {
    d.prepare("INSERT OR IGNORE INTO sources (name, created_at) VALUES (?, ?)").run(source, new Date().toISOString());
    d.prepare("INSERT OR IGNORE INTO picks (source, quarter, ticker, market, name, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      source,
      quarter,
      ticker,
      clean(p.market, 20) || "NSE",
      clean(p.name, 200) || null,
      new Date().toISOString(),
    );
  } finally {
    d.close();
  }
}

export function removePick(p: { source: string; quarter: string; ticker: string }): void {
  const d = db();
  try {
    d.prepare("DELETE FROM picks WHERE source = ? AND quarter = ? AND ticker = ?").run(
      clean(p.source, 60),
      clean(p.quarter, 7),
      clean(p.ticker, 30).toUpperCase(),
    );
  } finally {
    d.close();
  }
}

/** Delete a source and every pick under it. */
export function removeSource(name: string): void {
  const n = clean(name, 60);
  if (!n) throw new Error("Source name needed");
  const d = db();
  try {
    const tx = d.transaction(() => {
      d.prepare("DELETE FROM picks WHERE source = ?").run(n);
      d.prepare("DELETE FROM sources WHERE name = ?").run(n);
    });
    tx();
  } finally {
    d.close();
  }
}
