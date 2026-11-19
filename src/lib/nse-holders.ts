import { openSqliteNamed } from "./sqlite-utils";

/**
 * Named shareholders (> 1%) from NSE shareholding-pattern filings (XBRL).
 * Stored in metrics.db: holder_stakes (one row per symbol × quarter × holder)
 * and holder_scan (latest quarter scanned per symbol).
 */

const NSE = (process.env.NSE_ORIGIN || "https://www.nseindia.in").replace(/\/+$/, "");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type NamedStake = { holder: string; category: string; pct: number | null; shares: number | null };

export function withStakeDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T, readonly = false): T {
  const db = openSqliteNamed("metrics.db", { readonly, wal: true });
  try {
    if (!readonly) {
      db.pragma("busy_timeout = 5000");
      db.exec(`CREATE TABLE IF NOT EXISTS holder_stakes (
        symbol TEXT NOT NULL,
        quarter TEXT NOT NULL,
        holder TEXT NOT NULL,
        category TEXT,
        pct REAL,
        shares REAL,
        PRIMARY KEY (symbol, quarter, holder)
      );
      CREATE TABLE IF NOT EXISTS holder_scan (
        symbol TEXT PRIMARY KEY,
        quarter TEXT,
        scanned_at TEXT NOT NULL,
        ok INTEGER NOT NULL
      )`);
    }
    return fn(db);
  } finally {
    db.close();
  }
}

async function nseJson(path: string): Promise<unknown> {
  const res = await fetch(`${NSE}${path}`, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: `${NSE}/companies-listing/corporate-filings-shareholding-pattern`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`NSE ${res.status}`);
  return res.json();
}

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/** "30-SEP-2026" → "2026-09-30". */
function isoDate(d: string): string {
  const m = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/i.exec(d.trim());
  return m ? `${m[3]}-${MONTHS[m[2]!.toUpperCase()] ?? "01"}-${m[1]!.padStart(2, "0")}` : d;
}

/** Named shareholders (name, category, % of shares) from a shareholding XBRL file. */
export function parseShpXbrl(xml: string): NamedStake[] {
  const out: NamedStake[] = [];
  const nameRe = /<in-bse-shp:NameOfTheShareholder[^>]*contextRef="D_([^"]+)"[^>]*>([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(xml))) {
    const ctx = m[1]!;
    const name = m[2]!.replace(/\s+/g, " ").trim();
    const esc = ctx.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pctM = new RegExp(
      `<in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares[^>]*contextRef="${esc}"[^>]*>([^<]+)<`,
    ).exec(xml);
    const shM = new RegExp(`<in-bse-shp:NumberOfShares[^>]*contextRef="${esc}"[^>]*>([^<]+)<`).exec(xml);
    const pct = pctM ? Number(pctM[1]) * 100 : null;
    out.push({
      holder: name,
      category: ctx.replace(/_Context\d+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2"),
      pct: pct != null && Number.isFinite(pct) ? pct : null,
      shares: shM ? Number(shM[1]) : null,
    });
  }
  return out;
}

type Filing = { quarter: string; xbrl: string };

/** Shareholding filings for one company, newest first (one per quarter). */
async function listFilings(symbol: string, market: string): Promise<Filing[]> {
  // NSE keeps SME filings under a separate index.
  const index = market === "NSE SME" ? "sme" : "equities";
  const list = (await nseJson(
    `/api/corporate-share-holdings-master?index=${index}&symbol=${encodeURIComponent(symbol)}`,
  )) as Array<{ date?: string; xbrl?: string }>;
  const out: Filing[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(list) ? list : []) {
    if (!r.xbrl || !r.date) continue;
    const q = isoDate(r.date);
    if (seen.has(q)) continue;
    seen.add(q);
    out.push({ quarter: q, xbrl: r.xbrl });
  }
  return out.sort((a, b) => b.quarter.localeCompare(a.quarter));
}

function storedQuarters(symbol: string): Set<string> {
  return withStakeDb(
    (db) =>
      new Set(
        (
          db.prepare(`SELECT DISTINCT quarter FROM holder_stakes WHERE symbol = ?`).all(symbol) as Array<{
            quarter: string;
          }>
        ).map((r) => r.quarter),
      ),
    true,
  );
}

async function saveFiling(symbol: string, f: Filing, markLatest: boolean): Promise<void> {
  const res = await fetch(f.xbrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`XBRL ${res.status}`);
  const holders = parseShpXbrl(await res.text());
  const now = new Date().toISOString();
  withStakeDb((db) => {
    db.transaction(() => {
      db.prepare(`DELETE FROM holder_stakes WHERE symbol = ? AND quarter = ?`).run(symbol, f.quarter);
      const ins = db.prepare(
        `INSERT OR REPLACE INTO holder_stakes (symbol, quarter, holder, category, pct, shares) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const h of holders) ins.run(symbol, f.quarter, h.holder, h.category, h.pct, h.shares);
      if (markLatest) {
        db.prepare(`INSERT OR REPLACE INTO holder_scan (symbol, quarter, scanned_at, ok) VALUES (?, ?, ?, 1)`).run(
          symbol,
          f.quarter,
          now,
        );
      }
    })();
  });
}

/**
 * Scan one company's filings: the latest quarter, plus the `back` quarters
 * before it (for quarter-on-quarter changes). Quarters already stored are
 * not fetched again. Returns false when NSE has no filing.
 */
export async function scanHolders(symbol: string, market: string, back = 0): Promise<boolean> {
  const filings = await listFilings(symbol, market);
  const now = new Date().toISOString();
  if (!filings.length) {
    withStakeDb((db) =>
      db
        .prepare(`INSERT OR REPLACE INTO holder_scan (symbol, quarter, scanned_at, ok) VALUES (?, NULL, ?, 0)`)
        .run(symbol, now),
    );
    return false;
  }
  const have = storedQuarters(symbol);
  for (const [i, f] of filings.slice(0, back + 1).entries()) {
    if (have.has(f.quarter)) {
      if (i === 0) {
        withStakeDb((db) =>
          db
            .prepare(`INSERT OR REPLACE INTO holder_scan (symbol, quarter, scanned_at, ok) VALUES (?, ?, ?, 1)`)
            .run(symbol, f.quarter, now),
        );
      }
      continue;
    }
    await saveFiling(symbol, f, i === 0);
  }
  return true;
}

export type ScanState = { quarter: string | null; scanned_at: string; ok: number };

export function holderScanState(): Map<string, ScanState> {
  return withStakeDb(
    (db) =>
      new Map(
        (
          db.prepare(`SELECT symbol, quarter, scanned_at, ok FROM holder_scan`).all() as Array<
            ScanState & { symbol: string }
          >
        ).map((r) => [r.symbol, r]),
      ),
    true,
  );
}
