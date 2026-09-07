/**
 * NSE index constituents (Nifty 200 / Nifty 500) from nsearchives CSV lists.
 * Cached in data/index_constituents.db — same source as stocks-ai.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "index_constituents.db");

const NSE_ARCHIVES = "https://nsearchives.nseindia.com/content/indices";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const NIFTY_INDEX_IDS = ["NIFTY_200", "NIFTY_500"] as const;
export type NiftyIndexId = (typeof NIFTY_INDEX_IDS)[number];

export const NIFTY_INDEX_META: Record<
  NiftyIndexId,
  { label: string; short: string; csv: string }
> = {
  NIFTY_200: {
    label: "Nifty 200",
    short: "N200",
    csv: "ind_nifty200list.csv",
  },
  NIFTY_500: {
    label: "Nifty 500",
    short: "N500",
    csv: "ind_nifty500list.csv",
  },
};

export type IndexConstituentRow = {
  index_id: string;
  ticker: string;
  name: string | null;
  industry: string | null;
  isin: string | null;
  series: string | null;
  fetched_at: string;
};

const CACHE_MS = 30_000;
const caches = new Map<
  string,
  { at: number; set: Set<string>; rows: IndexConstituentRow[] }
>();

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_constituents (
      index_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      name TEXT,
      industry TEXT,
      isin TEXT,
      series TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (index_id, ticker)
    );
    CREATE INDEX IF NOT EXISTS idx_index_constituents_ticker
      ON index_constituents(ticker);
  `);
}

export function invalidateIndexConstituentsCache(
  indexId?: NiftyIndexId | string,
): void {
  if (indexId) caches.delete(indexId);
  else caches.clear();
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((c) => c.trim())) rows.push(row);
  }
  return rows;
}

function parseConstituentCsv(
  text: string,
  indexId: string,
  fetchedAt: string,
): IndexConstituentRow[] {
  const grid = parseCsv(text);
  if (grid.length < 2) return [];
  const header = grid[0]!.map((h) => h.trim().toLowerCase());
  const symIdx = header.findIndex((h) => h === "symbol");
  if (symIdx < 0) return [];
  const nameIdx = header.findIndex(
    (h) => h === "company name" || h === "company" || h === "name",
  );
  const industryIdx = header.findIndex((h) => h === "industry");
  const isinIdx = header.findIndex((h) => h === "isin code" || h === "isin");
  const seriesIdx = header.findIndex((h) => h === "series");

  const out: IndexConstituentRow[] = [];
  const seen = new Set<string>();
  for (const cells of grid.slice(1)) {
    const ticker = (cells[symIdx] ?? "").trim().toUpperCase();
    if (!ticker || ticker === "SYMBOL" || ticker === "SCRIP" || seen.has(ticker)) {
      continue;
    }
    seen.add(ticker);
    out.push({
      index_id: indexId,
      ticker,
      name: nameIdx >= 0 ? (cells[nameIdx] ?? "").trim() || null : null,
      industry:
        industryIdx >= 0 ? (cells[industryIdx] ?? "").trim() || null : null,
      isin: isinIdx >= 0 ? (cells[isinIdx] ?? "").trim() || null : null,
      series: seriesIdx >= 0 ? (cells[seriesIdx] ?? "").trim() || null : null,
      fetched_at: fetchedAt,
    });
  }
  return out;
}

export async function fetchIndexConstituentsFromNse(
  indexId: NiftyIndexId,
): Promise<IndexConstituentRow[]> {
  const meta = NIFTY_INDEX_META[indexId];
  if (!meta) throw new Error(`Unknown index_id: ${indexId}`);
  const url = `${NSE_ARCHIVES}/${meta.csv}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/csv,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.nseindia.com/",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`NSE ${indexId} HTTP ${res.status}`);
  }
  const text = await res.text();
  return parseConstituentCsv(text, indexId, new Date().toISOString());
}

export function replaceIndexConstituents(
  indexId: NiftyIndexId,
  rows: IndexConstituentRow[],
): number {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  try {
    ensureSchema(db);
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM index_constituents WHERE index_id = ?`).run(
        indexId,
      );
      const ins = db.prepare(`
        INSERT INTO index_constituents (
          index_id, ticker, name, industry, isin, series, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      let n = 0;
      for (const r of rows) {
        const ticker = (r.ticker || "").trim().toUpperCase();
        if (!ticker) continue;
        ins.run(
          indexId,
          ticker,
          r.name,
          r.industry,
          r.isin,
          r.series,
          r.fetched_at || new Date().toISOString(),
        );
        n += 1;
      }
      return n;
    });
    const n = tx();
    invalidateIndexConstituentsCache(indexId);
    return n;
  } finally {
    db.close();
  }
}

export function loadIndexConstituents(
  indexId: NiftyIndexId | string,
): IndexConstituentRow[] {
  const now = Date.now();
  const hit = caches.get(indexId);
  if (hit && now - hit.at < CACHE_MS) return hit.rows;

  if (!fs.existsSync(DB_PATH)) {
    caches.set(indexId, { at: now, set: new Set(), rows: [] });
    return [];
  }
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT index_id, ticker, name, industry, isin, series, fetched_at
         FROM index_constituents
         WHERE index_id = ?
         ORDER BY ticker COLLATE NOCASE`,
      )
      .all(indexId) as IndexConstituentRow[];
    const set = new Set(rows.map((r) => r.ticker.toUpperCase()));
    caches.set(indexId, { at: now, set, rows });
    return rows;
  } catch {
    caches.set(indexId, { at: now, set: new Set(), rows: [] });
    return [];
  } finally {
    db.close();
  }
}

export function indexTickerSet(indexId: NiftyIndexId | string): Set<string> {
  loadIndexConstituents(indexId);
  return caches.get(indexId)?.set ?? new Set();
}

export function isNifty200(ticker: string): boolean {
  return indexTickerSet("NIFTY_200").has(ticker.toUpperCase());
}

export function isNifty500(ticker: string): boolean {
  return indexTickerSet("NIFTY_500").has(ticker.toUpperCase());
}

export async function ensureIndexConstituents(
  indexId: NiftyIndexId,
  opts?: { force?: boolean },
): Promise<{ count: number; refreshed: boolean; error?: string }> {
  const cached = loadIndexConstituents(indexId);
  if (!opts?.force && cached.length > 0) {
    return { count: cached.length, refreshed: false };
  }
  try {
    const rows = await fetchIndexConstituentsFromNse(indexId);
    if (!rows.length) {
      return {
        count: cached.length,
        refreshed: false,
        error: "NSE returned empty list",
      };
    }
    const n = replaceIndexConstituents(indexId, rows);
    return { count: n, refreshed: true };
  } catch (err) {
    return {
      count: cached.length,
      refreshed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
