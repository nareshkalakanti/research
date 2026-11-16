import { invalidateGovernanceMapCache } from "./governance-map";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Fill unknown director roles (category blank — boards from MCA / Zauba only
 * say "Director") from the company's latest annual report on NSE. The board
 * section lists each director with a role ("Independent Non-Executive
 * Director", "Managing Director" …); names are matched on first + last name.
 */

const NSE = (process.env.NSE_ORIGIN || "https://www.nseindia.in").replace(/\/+$/, "");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_PDF_BYTES = 40 * 1024 * 1024;

export type ArFillResult = { ticker: string; report: string | null; filled: number; blank: number; note: string };

type Category = "Independent" | "Executive" | "Non-Executive";

async function latestAnnualReport(symbol: string, market: string): Promise<string | null> {
  const index = market === "NSE SME" ? "sme" : "equities";
  const res = await fetch(`${NSE}/api/annual-reports?index=${index}&symbol=${encodeURIComponent(symbol)}`, {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: `${NSE}/companies-listing/corporate-filings-annual-reports` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { data?: Array<{ fileName?: string; toYr?: string }> };
  const rows = (j.data ?? []).filter((r) => r.fileName && /\.pdf(\?|$)/i.test(r.fileName));
  rows.sort((a, b) => Number(b.toYr ?? 0) - Number(a.toYr ?? 0));
  return rows[0]?.fileName ?? null;
}

/** PDF → text, keeping line breaks (role is usually on the director's line). */
async function pdfLines(url: string): Promise<string[]> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`report ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_PDF_BYTES) throw new Error("report too large");
  const buf = Buffer.from(await res.arrayBuffer());
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (b: Buffer) => Promise<{ text?: string }>;
  const errWrite = process.stderr.write.bind(process.stderr);
  // pdf-parse prints font warnings for most annual reports — keep the log clean.
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    const s = typeof chunk === "string" ? chunk : String(chunk);
    if (/private use area|undefined function|warning/i.test(s)) return true;
    return errWrite(chunk as never, ...(args as never[]));
  }) as typeof process.stderr.write;
  try {
    const parsed = await pdfParse(buf);
    return (parsed.text || "")
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  } finally {
    process.stderr.write = errWrite;
  }
}

const TITLES = /^(shri|smt|sri|mr|mrs|ms|miss|dr|prof|cs|ca|late)\.?$/i;

function nameKeys(name: string): { first: string; last: string } | null {
  const parts = name
    .replace(/[().,]/g, " ")
    .split(/\s+/)
    .filter((p) => p && !TITLES.test(p) && p.length > 1);
  if (parts.length < 2) return null;
  return { first: parts[0]!.toLowerCase(), last: parts[parts.length - 1]!.toLowerCase() };
}

/** Role from the text right after a director's name (stops at the next list item). */
function roleFrom(after: string): Category | null {
  const t = after
    .slice(0, 90)
    .split(/\s\d{1,2}[.)]\s|;|\b(?:shri|smt|mr|mrs|ms|dr)\.?\s/i)[0]!
    .toLowerCase();
  if (/non[-\s]?independent/.test(t)) {
    return /(managing|whole[-\s]?time|executive director)/.test(t) && !/non[-\s]?executive/.test(t)
      ? "Executive"
      : "Non-Executive";
  }
  if (/\bindependent\b/.test(t)) return "Independent";
  if (/(managing director|whole[-\s]?time|executive director|\bceo\b|chief executive)/.test(t) && !/non[-\s]?executive/.test(t)) {
    return "Executive";
  }
  if (/non[-\s]?executive|nominee/.test(t)) return "Non-Executive";
  return null;
}

/** Vote across every line that mentions the director (first + last name). */
function classify(lines: string[], name: string): Category | null {
  const k = nameKeys(name);
  if (!k) return null;
  const votes = new Map<Category, number>();
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i]!.toLowerCase();
    const fi = low.indexOf(k.first);
    const li = low.indexOf(k.last, fi + 1);
    if (fi < 0 || li < 0 || li - fi > 40) continue;
    const after = `${lines[i]!.slice(li + k.last.length)} ${lines[i + 1] ?? ""}`;
    const role = roleFrom(after.replace(/^[\s\-–—:,]+/, ""));
    if (role) votes.set(role, (votes.get(role) ?? 0) + 1);
  }
  if (!votes.size) return null;
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

function withGov<T>(write: boolean, fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("governance.db", { readonly: !write, wal: true });
  try {
    if (write) {
      db.pragma("busy_timeout = 8000");
      db.exec(`CREATE TABLE IF NOT EXISTS ar_role_scan (
        ticker TEXT PRIMARY KEY,
        report TEXT,
        filled INTEGER NOT NULL,
        blank INTEGER NOT NULL,
        note TEXT,
        scanned_at TEXT NOT NULL
      )`);
    }
    return fn(db);
  } finally {
    db.close();
  }
}

/** Companies tried in the last 30 days (skip until a new report is likely). */
export function recentlyTriedAr(): Set<string> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  try {
    return withGov(true, (db) =>
      new Set(
        (db.prepare(`SELECT ticker FROM ar_role_scan WHERE scanned_at >= ?`).all(since) as Array<{ ticker: string }>).map(
          (r) => r.ticker,
        ),
      ),
    );
  } catch {
    return new Set();
  }
}

/** Fill blank director categories for one company from its latest annual report. */
export async function fillRolesFromAnnualReport(ticker: string, market: string): Promise<ArFillResult> {
  const t = ticker.toUpperCase();
  const blank = withGov(false, (db) =>
    db
      .prepare(
        `SELECT s.id, s.designation, d.name FROM board_seats s JOIN directors d ON d.person_id = s.person_id
         WHERE UPPER(s.ticker) = ? AND TRIM(COALESCE(s.category, '')) = ''`,
      )
      .all(t) as Array<{ id: number; designation: string; name: string }>,
  );
  const done = (r: Omit<ArFillResult, "ticker" | "blank">): ArFillResult => {
    withGov(true, (db) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO ar_role_scan (ticker, report, filled, blank, note, scanned_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(t, r.report, r.filled, blank.length, r.note, new Date().toISOString()),
    );
    return { ticker: t, blank: blank.length, ...r };
  };
  if (!blank.length) return done({ report: null, filled: 0, note: "nothing blank" });

  const url = await latestAnnualReport(t, market);
  if (!url) return done({ report: null, filled: 0, note: "no annual report on NSE" });
  let lines: string[];
  try {
    lines = await pdfLines(url);
  } catch (e) {
    return done({ report: url, filled: 0, note: e instanceof Error ? e.message : "could not read report" });
  }
  if (lines.length < 50) return done({ report: url, filled: 0, note: "report has no text (scanned image)" });

  const updates: Array<{ id: number; cat: Category; designation: string }> = [];
  for (const b of blank) {
    const cat = classify(lines, b.name);
    if (!cat) continue;
    const generic = /^(additional )?director$/i.test(b.designation.trim());
    updates.push({
      id: b.id,
      cat,
      designation: generic
        ? cat === "Independent"
          ? "Independent Director"
          : cat === "Executive"
            ? "Executive Director"
            : "Non-Executive Director"
        : b.designation,
    });
  }
  if (updates.length) {
    withGov(true, (db) => {
      const up = db.prepare(`UPDATE board_seats SET category = ?, designation = ? WHERE id = ?`);
      const tx = db.transaction(() => {
        for (const u of updates) up.run(u.cat, u.designation, u.id);
      });
      tx();
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        /* best effort */
      }
    });
    invalidateGovernanceMapCache();
  }
  return done({
    report: url,
    filled: updates.length,
    note: updates.length ? `filled ${updates.length} of ${blank.length}` : "directors not found in report",
  });
}
