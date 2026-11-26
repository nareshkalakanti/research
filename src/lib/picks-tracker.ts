import { openSqliteNamed } from "./sqlite-utils";
import { loadAllCompanies } from "./db";
import { listFundCatalog } from "./fund-watchlists";
import { fundHistoryForList, peopleListLabels, type FundHistory } from "./screener-people";
import { loadStockMaster, masterLabels } from "./stock-master";

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
  /** Market cap (₹ Cr) and website from the company list, read at load time. */
  mcap_cr: number | null;
  web: string | null;
  added_at: string;
};

/** funds: per source, the stake history of the fund pages behind the watchlist with the same name (if any). */
export type PicksData = { sources: string[]; picks: Pick[]; funds?: Record<string, FundHistory> };

/**
 * A source's fund watchlist, matched by name ignoring case, spaces and punctuation: the list's key, its label,
 * or the name its Screener pages are followed under. "Niveshaay" → niveshaay, "Ashish Kacholia" → kacholia.
 */
function fundsBySource(sources: string[]): Record<string, FundHistory> {
  const out: Record<string, FundHistory> = {};
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = new Map<string, string>(); // normalized name → list key
  try {
    for (const c of listFundCatalog()) {
      names.set(norm(c.key), c.key);
      names.set(norm(c.label), c.key);
    }
    for (const p of peopleListLabels()) names.set(norm(p.label), p.key);
  } catch {
    return out;
  }
  for (const s of sources) {
    const key = names.get(norm(s));
    if (!key) continue;
    try {
      const h = fundHistoryForList(key);
      if (h.funds.length) out[s] = h;
    } catch {
      /* no fund history yet */
    }
  }
  return out;
}

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
    const companies = new Map(loadAllCompanies().map((c) => [c.ticker.toUpperCase(), c]));
    const master = loadStockMaster();
    const sources = (d.prepare("SELECT name FROM sources ORDER BY created_at").all() as Array<{ name: string }>).map((r) => r.name);
    const picks = (
      d.prepare("SELECT source, quarter, ticker, market, name, added_at FROM picks ORDER BY quarter, source, added_at").all() as Array<
        Omit<Pick, "sector" | "industry" | "mcap_cr" | "web">
      >
    ).map((p) => {
      const t = p.ticker.toUpperCase();
      const lab = labels.get(t);
      const co = companies.get(t);
      // Exchange from the listing (NSE / NSE SME / BSE / BSE SME), else what was saved with the pick.
      const market = co?.market || master.get(t)?.exchange || p.market;
      return {
        ...p,
        market,
        sector: lab?.sector ?? null,
        industry: lab?.industry ?? null,
        mcap_cr: co?.mcap_cr ?? null,
        web: co?.web ?? null,
      };
    });
    return { sources, picks, funds: fundsBySource(sources) };
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

export type BulkAddResult = { added: string[]; already: string[] };

/** Add a list of stocks (picked from search) to one source's quarter in one go. */
export function addPicks(p: {
  source: string;
  quarter: string;
  items: Array<{ ticker?: unknown; market?: unknown; name?: unknown }>;
}): BulkAddResult {
  const source = clean(p.source, 60);
  const quarter = clean(p.quarter, 7);
  if (!source || !QUARTER_RE.test(quarter)) throw new Error("source and quarter (YYYY-Qn) needed");
  const items = (Array.isArray(p.items) ? p.items : []).slice(0, 300);
  const res: BulkAddResult = { added: [], already: [] };
  const d = db();
  try {
    const now = new Date().toISOString();
    const ins = d.prepare("INSERT OR IGNORE INTO picks (source, quarter, ticker, market, name, added_at) VALUES (?, ?, ?, ?, ?, ?)");
    d.transaction(() => {
      d.prepare("INSERT OR IGNORE INTO sources (name, created_at) VALUES (?, ?)").run(source, now);
      const seen = new Set<string>();
      for (const it of items) {
        const ticker = clean(it?.ticker, 30).toUpperCase();
        if (!ticker || seen.has(ticker)) continue;
        seen.add(ticker);
        const r = ins.run(source, quarter, ticker, clean(it?.market, 20) || "NSE", clean(it?.name, 200) || null, now);
        (r.changes ? res.added : res.already).push(ticker);
      }
    })();
  } finally {
    d.close();
  }
  if (!res.added.length && !res.already.length) throw new Error("Pick at least one stock");
  return res;
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

/** Rename a source; its picks move with it. Refuses a name another source already uses. */
export function renameSource(from: string, to: string): void {
  const a = clean(from, 60);
  const b = clean(to, 60);
  if (!a || !b) throw new Error("Old and new source names needed");
  if (a === b) return;
  const d = db();
  try {
    d.transaction(() => {
      if (!d.prepare("SELECT 1 FROM sources WHERE name = ?").get(a)) throw new Error(`No source “${a}”`);
      // Same name in another case ("niveshaay" → "Niveshaay") is a plain rename, not a clash.
      const clash = d.prepare("SELECT name FROM sources WHERE name = ? COLLATE NOCASE AND name != ?").get(b, a);
      if (clash) throw new Error(`A source named “${b}” already exists`);
      d.prepare("UPDATE sources SET name = ? WHERE name = ?").run(b, a);
      d.prepare("UPDATE picks SET source = ? WHERE source = ?").run(b, a);
    })();
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
