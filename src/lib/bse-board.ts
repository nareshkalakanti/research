import { BSE_HEADERS } from "./bse-sme";
import { listListingCompaniesLite } from "./db";
import { parseCurrentDirectorsTable } from "./din-mca-lookup";
import { dinBoardTickerSet, getGovernanceWriteDb, saveCompanyBoard } from "./governance-write";
import { inferDirectorCategory, type BoardSeat } from "./nse-governance";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * DIN boards for BSE main-board companies (not on NSE, so the NSE governance
 * scan can't reach them):
 *   1. BSE CorpInfo (by scrip code) → CIN + the official director list with
 *      roles ("Non-Executive - Independent Director" …)
 *   2. Tofler company page by CIN → current directors with DINs
 *   3. Names matched across both, so each seat keeps BSE's official role
 *      (and the independence count is right).
 */

const CORP_INFO = "https://api.bseindia.com/BseIndiaAPI/api/CorpInfo/w";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** Pause between companies (BSE + Tofler, one request each). */
const GAP_MS = 1500;

export type BseBoardJob = { ticker: string; name: string; scrip_code: string };

export type BseBoardResult = {
  ticker: string;
  status: "saved" | "empty" | "no_cin" | "failed";
  seats: number;
  cin: string | null;
  detail: string;
};

function scripCodes(): Map<string, string> {
  const out = new Map<string, string>();
  const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
  try {
    for (const r of db
      .prepare(`SELECT UPPER(ticker) AS t, scrip_code FROM company_bse_scrip WHERE TRIM(COALESCE(scrip_code, '')) != ''`)
      .all() as Array<{ t: string; scrip_code: string }>)
      out.set(r.t, r.scrip_code.trim());
  } finally {
    db.close();
  }
  return out;
}

/** Skip a company for this long after an empty / failed try. */
const RETRY_MS = 14 * 86_400_000;

function recentFailures(): Set<string> {
  const out = new Set<string>();
  // Same long-lived connection the board writer uses — never a second handle on governance.db.
  try {
    // Empty registry page / no CIN: 14 days. Timeouts and errors: next day.
    const cut = new Date(Date.now() - RETRY_MS).toISOString();
    const cutFailed = new Date(Date.now() - 86_400_000).toISOString();
    for (const r of getGovernanceWriteDb()
      .prepare(
        `SELECT UPPER(ticker) AS t FROM scan_log
         WHERE (status IN ('bse_empty', 'bse_no_cin') AND fetched_at >= ?)
            OR (status = 'bse_failed' AND fetched_at >= ?)`,
      )
      .all(cut, cutFailed) as Array<{ t: string }>)
      out.add(r.t);
  } catch {
    /* optional */
  }
  return out;
}

function logAttempt(r: BseBoardResult): void {
  try {
    getGovernanceWriteDb()
      .prepare(
        `INSERT INTO scan_log (ticker, status, detail, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ticker) DO UPDATE SET status = excluded.status, detail = excluded.detail, fetched_at = excluded.fetched_at`,
      )
      .run(r.ticker, `bse_${r.status}`, r.detail, new Date().toISOString());
  } catch {
    /* best effort */
  }
}

/** BSE main-board names with a scrip code, no DIN board, not tried in the last 14 days. */
export function pendingBseBoardJobs(opts?: { tickers?: string[] }): BseBoardJob[] {
  const done = dinBoardTickerSet();
  const failed = opts?.tickers?.length ? new Set<string>() : recentFailures();
  const codes = scripCodes();
  const only = opts?.tickers?.length ? new Set(opts.tickers.map((t) => t.toUpperCase())) : null;
  const jobs: BseBoardJob[] = [];
  for (const c of listListingCompaniesLite()) {
    const t = c.ticker.toUpperCase();
    const mkt = (c.market || "").toUpperCase();
    // Main board by default; BSE SME too when the caller names the ticker.
    const bseOk = mkt === "BSE" || (only != null && mkt.startsWith("BSE"));
    if (!bseOk || done.has(t) || failed.has(t)) continue;
    if (only && !only.has(t)) continue;
    const code = codes.get(t);
    if (code) jobs.push({ ticker: t, name: c.name || t, scrip_code: code });
  }
  return jobs.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

type CorpInfo = {
  cin: string | null;
  directors: Array<{ name: string; designation: string }>;
};

async function fetchCorpInfo(code: string): Promise<CorpInfo | null> {
  const res = await fetch(`${CORP_INFO}?scripcode=${encodeURIComponent(code)}`, {
    headers: BSE_HEADERS,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    Table?: Array<{ sFirstname?: string; sMiddlename?: string; sLastname?: string; sDesignation?: string }>;
    Table3?: Array<{ fld_cin?: string }>;
  };
  const cin = (j.Table3?.[0]?.fld_cin || "").trim().toUpperCase();
  return {
    cin: /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/.test(cin) ? cin : null,
    directors: (j.Table ?? [])
      .map((d) => ({
        name: [d.sFirstname, d.sMiddlename, d.sLastname].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
        designation: (d.sDesignation || "").trim(),
      }))
      .filter((d) => d.name),
  };
}

async function fetchToflerSeats(cin: string): Promise<BoardSeat[]> {
  try {
    const res = await fetch(`https://www.tofler.in/company/company/${cin}`, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    if (/just a moment|security verification/i.test(html)) return [];
    return parseCurrentDirectorsTable(html);
  } catch {
    return [];
  }
}

const tokens = (n: string) =>
  new Set(
    n
      .toUpperCase()
      .replace(/[^A-Z ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !["MR", "MRS", "MS", "DR", "SHRI", "SMT"].includes(w)),
  );

const first = (n: string) => [...tokens(n)][0] ?? "";

/**
 * Pair registry directors with BSE's list: shared name words (≥ 2, or all of a
 * 1-word name), first-name match as tie-break; each BSE entry used once.
 */
function matchDesignations(names: string[], bse: CorpInfo["directors"]): Array<string | null> {
  const pairs: Array<{ i: number; j: number; score: number }> = [];
  names.forEach((n, i) => {
    const a = tokens(n);
    bse.forEach((b, j) => {
      const bt = tokens(b.name);
      let hit = 0;
      for (const w of a) if (bt.has(w)) hit += 1;
      if (hit === 0 || hit < Math.min(2, a.size, bt.size)) return;
      const jacc = hit / new Set([...a, ...bt]).size;
      pairs.push({ i, j, score: jacc + (first(n) === first(b.name) ? 0.5 : 0) });
    });
  });
  pairs.sort((x, y) => y.score - x.score);
  const out: Array<string | null> = names.map(() => null);
  const usedB = new Set<number>();
  for (const p of pairs) {
    if (out[p.i] != null || usedB.has(p.j)) continue;
    out[p.i] = bse[p.j]!.designation || null;
    usedB.add(p.j);
  }
  return out;
}

export async function fillBseBoard(job: BseBoardJob): Promise<BseBoardResult> {
  const info = await fetchCorpInfo(job.scrip_code);
  if (!info) return { ticker: job.ticker, status: "failed", seats: 0, cin: null, detail: "BSE CorpInfo unavailable" };
  if (!info.cin) return { ticker: job.ticker, status: "no_cin", seats: 0, cin: null, detail: "No CIN on BSE" };
  const tofler = await fetchToflerSeats(info.cin);
  if (!tofler.length)
    return { ticker: job.ticker, status: "empty", seats: 0, cin: info.cin, detail: "Registry page had no DIN table" };
  const roles = matchDesignations(
    tofler.map((s) => s.name),
    info.directors,
  );
  const seats: BoardSeat[] = tofler.map((s, i) => {
    const official = roles[i];
    const designation = official || s.designation;
    return {
      ...s,
      designation,
      category: inferDirectorCategory(designation) || s.category,
      source: official ? "bse_corpinfo+registry" : "registry_current_directors",
    };
  });
  const r = saveCompanyBoard({
    ticker: job.ticker,
    name: job.name,
    market: "BSE",
    seats,
    replaceSeats: true,
    notes: `BSE CorpInfo roles + registry DINs (CIN ${info.cin})`,
  });
  saveCin(job.ticker, info.cin);
  if (r.skipped)
    return { ticker: job.ticker, status: "empty", seats: 0, cin: info.cin, detail: `Not saved: ${r.reason ?? "skipped"}` };
  const matched = seats.filter((s) => s.source === "bse_corpinfo+registry").length;
  return {
    ticker: job.ticker,
    status: "saved",
    seats: r.seats,
    cin: info.cin,
    detail: `${r.seats} DIN seats · ${matched} with BSE roles`,
  };
}

function saveCin(ticker: string, cin: string): void {
  try {
    getGovernanceWriteDb()
      .prepare(`UPDATE companies SET cin = ? WHERE UPPER(ticker) = ? AND TRIM(COALESCE(cin, '')) = ''`)
      .run(cin, ticker);
  } catch {
    /* CIN optional */
  }
}

/** One batch (UI loops until remaining = 0). */
export async function runBseBoardBatch(opts?: { tickers?: string[]; limit?: number }): Promise<{
  tried: number;
  saved: number;
  remaining: number;
  details: BseBoardResult[];
}> {
  const limit = Math.min(10, Math.max(1, opts?.limit ?? 5));
  const jobs = pendingBseBoardJobs({ tickers: opts?.tickers }).slice(0, limit);
  const details: BseBoardResult[] = [];
  for (const j of jobs) {
    let r: BseBoardResult;
    try {
      r = await fillBseBoard(j);
    } catch (e) {
      r = { ticker: j.ticker, status: "failed", seats: 0, cin: null, detail: String(e).slice(0, 160) };
    }
    details.push(r);
    logAttempt(r);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  const saved = details.filter((d) => d.status === "saved").length;
  // Empty / failed tries are skipped for 14 days, so the loop always ends.
  return { tried: details.length, saved, remaining: pendingBseBoardJobs().length, details };
}
