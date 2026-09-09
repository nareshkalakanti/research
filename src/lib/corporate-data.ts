/**
 * Corporate Data — announcement PDF → extract vs known DIN board (manual-first).
 */
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import {
  getGovernanceWriteDb,
  dinBoardTickerSet,
  saveCompanyBoard,
  recordScanAttempt,
  type SaveBoardResult,
} from "./governance-write";
import { loadHoldings } from "./holdings";
import { loadAllCompanies } from "./db";
import { tradingviewUrl } from "./links";
import { type BoardSeat } from "./nse-governance";
import { primaryCorporateEventKeyword } from "./corporate-event-keywords";
import { dateFromNseArchiveUrl } from "./corporate-data-announcements";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "corporate_data.db");

/** Manual test set: 5 NSE SME + 5 NSE with DIN-backed boards already in governance.db */
export const CORPORATE_DATA_SEED: Array<{
  ticker: string;
  market: "NSE" | "NSE SME";
}> = [
  { ticker: "PHANTOMFX", market: "NSE SME" },
  { ticker: "ESFL", market: "NSE SME" },
  { ticker: "C2C", market: "NSE SME" },
  { ticker: "NEPHROCARE", market: "NSE SME" },
  { ticker: "RNFI", market: "NSE SME" },
  { ticker: "HAVELLS", market: "NSE" },
  { ticker: "ITC", market: "NSE" },
  { ticker: "ESCORTS", market: "NSE" },
  { ticker: "SBIN", market: "NSE" },
  { ticker: "CENTURYPLY", market: "NSE" },
];

export type CorporateDirectorExtract = {
  name: string;
  din: string | null;
  designation: string | null;
  category: string | null;
  as_of: string | null;
  tenure_end: string | null;
  committees: string[] | null;
  age: number | null;
  dob: string | null;
  shareholding_pct: number | null;
  promoter: boolean | null;
  related_party: boolean | null;
  qualification: string | null;
};

export type CorporateKmpExtract = {
  name: string;
  din: string | null;
  role: string | null;
};

export type CorporateExtractPayload = {
  directors: CorporateDirectorExtract[];
  kmp: CorporateKmpExtract[];
  company: { cin: string | null; isin: string | null };
  extras: {
    earnings_snip: string | null;
    order_wins: string | null;
    credit_rating: string | null;
    buyback: string | null;
    clarification: string | null;
  };
  /** Latest earnings / conference-call extract (investor_materials or Trendlyne) */
  concall: {
    period: string | null;
    url: string | null;
    title: string | null;
    summary: string | null;
    guidance: string | null;
    margins: string | null;
    capex: string | null;
    orders: string | null;
    tone: string | null;
    sentiment: string | null;
    sentiment_score: number | null;
    sentiment_why: string | null;
    risks: string | null;
    source: string | null;
  } | null;
  source_url: string | null;
  notes: string | null;
};

export type CorporateGap = {
  /** DINs in extract that also appear in Expected */
  match_din: number;
  /** Expected DIN seats not present in extract (normal for appointment filings) */
  missing_din: number;
  /** Extracted people with a name but no DIN */
  names_no_din: number;
  /** Short flags for UI: empty | wrong_doc | names_no_din | kmp_only | din_ok | partial */
  flags: string[];
  summary: string;
};

export type CorporateDataRow = {
  ticker: string;
  name: string;
  market: string;
  tv: string;
  document_url: string | null;
  document_title: string | null;
  document_date: string | null;
  concall_url: string | null;
  concall_title: string | null;
  concall_period: string | null;
  concall_date: string | null;
  extracted: CorporateExtractPayload | null;
  expected: CorporateExtractPayload;
  gap: CorporateGap;
  extract_engine: string | null;
  extract_status: string | null;
  updated_at: string | null;
};

let db: Database.Database | null = null;

function ensureDb(): Database.Database {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS corporate_rows (
      ticker TEXT PRIMARY KEY,
      market TEXT NOT NULL,
      document_url TEXT,
      document_title TEXT,
      extracted_json TEXT,
      extract_engine TEXT,
      extract_status TEXT,
      updated_at TEXT
    );
  `);
  const cols = (
    conn.prepare(`PRAGMA table_info(corporate_rows)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!cols.includes("concall_url")) {
    conn.exec(`ALTER TABLE corporate_rows ADD COLUMN concall_url TEXT`);
  }
  if (!cols.includes("concall_title")) {
    conn.exec(`ALTER TABLE corporate_rows ADD COLUMN concall_title TEXT`);
  }
  if (!cols.includes("concall_period")) {
    conn.exec(`ALTER TABLE corporate_rows ADD COLUMN concall_period TEXT`);
  }
  if (!cols.includes("concall_date")) {
    conn.exec(`ALTER TABLE corporate_rows ADD COLUMN concall_date TEXT`);
  }
  if (!cols.includes("document_date")) {
    conn.exec(`ALTER TABLE corporate_rows ADD COLUMN document_date TEXT`);
  }
  db = conn;
  return conn;
}

export function emptyExtract(
  sourceUrl: string | null = null,
): CorporateExtractPayload {
  return {
    directors: [],
    kmp: [],
    company: { cin: null, isin: null },
    extras: {
      earnings_snip: null,
      order_wins: null,
      credit_rating: null,
      buyback: null,
      clarification: null,
    },
    concall: null,
    source_url: sourceUrl,
    notes: null,
  };
}

/** Ground truth from governance.db DIN seats (practical minimum + null extras). */
export function expectedFromGovernance(
  ticker: string,
): CorporateExtractPayload {
  const t = ticker.toUpperCase();
  const gov = getGovernanceWriteDb();
  const seats = gov
    .prepare(
      `
      SELECT d.din, d.name, s.designation, s.category, s.as_of
      FROM board_seats s
      JOIN directors d ON d.person_id = s.person_id
      WHERE s.ticker = ?
        AND d.din IS NOT NULL AND TRIM(d.din) != ''
      ORDER BY d.name COLLATE NOCASE
      `,
    )
    .all(t) as Array<{
    din: string;
    name: string;
    designation: string;
    category: string | null;
    as_of: string | null;
  }>;

  const base = emptyExtract(null);
  base.directors = seats.map((s) => ({
    name: s.name,
    din: s.din,
    designation: s.designation || null,
    category: s.category || null,
    as_of: s.as_of || null,
    tenure_end: null,
    committees: null,
    age: null,
    dob: null,
    shareholding_pct: null,
    promoter: null,
    related_party: null,
    qualification: null,
  }));
  base.notes =
    "Expected = DIN seats already in governance.db (verify extract against this).";
  return base;
}

function companyName(ticker: string): string {
  const t = ticker.toUpperCase();
  try {
    const row = getGovernanceWriteDb()
      .prepare(`SELECT name FROM companies WHERE ticker = ?`)
      .get(t) as { name?: string } | undefined;
    if (row?.name?.trim()) return row.name.trim();
  } catch {
    /* ignore */
  }
  try {
    const c = loadAllCompanies().find((x) => x.ticker.toUpperCase() === t);
    if (c?.name?.trim()) return c.name.trim();
  } catch {
    /* ignore */
  }
  return t;
}

export type PushGovResult = {
  ok: boolean;
  ticker: string;
  pushed: number;
  skipped?: boolean;
  reason?: string;
  events_recorded?: number;
};

/**
 * Additive upsert: extracted director DINs → governance.db board seats
 * (does not wipe existing seats).
 */
export function pushExtractToGovernance(opts: {
  ticker: string;
  market: string;
  name?: string | null;
  extracted?: CorporateExtractPayload | null;
}): PushGovResult {
  const ticker = opts.ticker.trim().toUpperCase();
  if (!ticker) {
    return { ok: false, ticker: "", pushed: 0, reason: "ticker required" };
  }

  let extracted = opts.extracted ?? null;
  if (!extracted) {
    const conn = ensureDb();
    const row = conn
      .prepare(`SELECT extracted_json FROM corporate_rows WHERE ticker = ?`)
      .get(ticker) as { extracted_json: string | null } | undefined;
    extracted = parseExtracted(row?.extracted_json ?? null);
  }
  if (!extracted) {
    return { ok: false, ticker, pushed: 0, reason: "No extract stored" };
  }

  const byDin = new Map<string, BoardSeat>();
  for (const d of extracted.directors || []) {
    const din = normDin(d.din);
    if (!din || din.length !== 8) continue;
    const name = (d.name || "").trim();
    if (!name) continue;
    byDin.set(din, {
      din,
      name,
      designation: (d.designation || "").trim() || "Director",
      category: (d.category || "").trim(),
      source: "corporate_pdf",
      as_of: (d.as_of || "").trim(),
    });
  }
  if (!byDin.size) {
    return {
      ok: false,
      ticker,
      pushed: 0,
      reason: "No director DINs in extract",
    };
  }

  const seats = [...byDin.values()];
  let saved: SaveBoardResult;
  try {
    saved = saveCompanyBoard({
      ticker,
      name: (opts.name || "").trim() || companyName(ticker),
      market: opts.market,
      seats,
      replaceSeats: false,
      notes: "Additive seats from Corporate Data PDF extract",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, ticker, pushed: 0, reason: msg };
  }

  if (saved.skipped) {
    return {
      ok: false,
      ticker,
      pushed: 0,
      skipped: true,
      reason: saved.reason,
    };
  }

  recordScanAttempt(
    ticker,
    "ok",
    `corporate_pdf additive ${seats.length} DIN seat(s)`,
  );

  return {
    ok: true,
    ticker,
    pushed: seats.length,
    events_recorded: saved.events_recorded,
  };
}

/** Push all stored extracts on a corporate list that have director DINs. */
export function pushListExtractsToGovernance(
  market: CorporateListFilter,
): {
  attempted: number;
  ok: number;
  failed: number;
  pushed_seats: number;
  results: PushGovResult[];
} {
  const rows = listCorporateDataRows(market);
  const results: PushGovResult[] = [];
  let ok = 0;
  let failed = 0;
  let pushed_seats = 0;
  for (const r of rows) {
    const hasDin = (r.extracted?.directors || []).some((d) => !!normDin(d.din));
    if (!hasDin) continue;
    const out = pushExtractToGovernance({
      ticker: r.ticker,
      market: r.market,
      name: r.name,
      extracted: r.extracted,
    });
    results.push(out);
    if (out.ok) {
      ok += 1;
      pushed_seats += out.pushed;
    } else {
      failed += 1;
    }
  }
  return {
    attempted: results.length,
    ok,
    failed,
    pushed_seats,
    results,
  };
}

export function upsertCorporateDocument(row: {
  ticker: string;
  market: string;
  document_url: string | null;
  document_title: string | null;
  document_date?: string | null;
}): void {
  const conn = ensureDb();
  const ticker = row.ticker.toUpperCase();
  const now = new Date().toISOString();
  conn
    .prepare(
      `
      INSERT INTO corporate_rows (
        ticker, market, document_url, document_title, document_date, updated_at
      )
      VALUES (
        @ticker, @market, @document_url, @document_title, @document_date, @updated_at
      )
      ON CONFLICT(ticker) DO UPDATE SET
        market = excluded.market,
        document_url = COALESCE(excluded.document_url, corporate_rows.document_url),
        document_title = COALESCE(excluded.document_title, corporate_rows.document_title),
        document_date = COALESCE(excluded.document_date, corporate_rows.document_date),
        updated_at = excluded.updated_at
      `,
    )
    .run({
      ticker,
      market: row.market,
      document_url: row.document_url,
      document_title: row.document_title,
      document_date: row.document_date ?? null,
      updated_at: now,
    });
}

export function upsertCorporateConcall(row: {
  ticker: string;
  market: string;
  concall_url: string | null;
  concall_title: string | null;
  concall_period: string | null;
  concall_date?: string | null;
  /** When true, replace stored concall even if older fields were set (Scan latest). */
  force?: boolean;
}): void {
  const conn = ensureDb();
  const ticker = row.ticker.toUpperCase();
  const now = new Date().toISOString();
  const force = row.force !== false;
  conn
    .prepare(
      `
      INSERT INTO corporate_rows (
        ticker, market, concall_url, concall_title, concall_period, concall_date, updated_at
      ) VALUES (
        @ticker, @market, @concall_url, @concall_title, @concall_period, @concall_date, @updated_at
      )
      ON CONFLICT(ticker) DO UPDATE SET
        market = excluded.market,
        concall_url = ${force ? "excluded.concall_url" : "COALESCE(excluded.concall_url, corporate_rows.concall_url)"},
        concall_title = ${force ? "excluded.concall_title" : "COALESCE(excluded.concall_title, corporate_rows.concall_title)"},
        concall_period = ${force ? "excluded.concall_period" : "COALESCE(excluded.concall_period, corporate_rows.concall_period)"},
        concall_date = ${force ? "excluded.concall_date" : "COALESCE(excluded.concall_date, corporate_rows.concall_date)"},
        updated_at = excluded.updated_at
      `,
    )
    .run({
      ticker,
      market: row.market,
      concall_url: row.concall_url,
      concall_title: row.concall_title,
      concall_period: row.concall_period,
      concall_date: row.concall_date ?? null,
      updated_at: now,
    });
}

export function saveCorporateExtract(opts: {
  ticker: string;
  market: string;
  extracted: CorporateExtractPayload;
  engine: string;
  status: string;
  document_url?: string | null;
  document_title?: string | null;
}): void {
  const conn = ensureDb();
  const ticker = opts.ticker.toUpperCase();
  const now = new Date().toISOString();
  conn
    .prepare(
      `
      INSERT INTO corporate_rows (
        ticker, market, document_url, document_title,
        extracted_json, extract_engine, extract_status, updated_at
      ) VALUES (
        @ticker, @market, @document_url, @document_title,
        @extracted_json, @extract_engine, @extract_status, @updated_at
      )
      ON CONFLICT(ticker) DO UPDATE SET
        market = excluded.market,
        document_url = COALESCE(excluded.document_url, corporate_rows.document_url),
        document_title = COALESCE(excluded.document_title, corporate_rows.document_title),
        extracted_json = excluded.extracted_json,
        extract_engine = excluded.extract_engine,
        extract_status = excluded.extract_status,
        updated_at = excluded.updated_at
      `,
    )
    .run({
      ticker,
      market: opts.market,
      document_url: opts.document_url ?? null,
      document_title: opts.document_title ?? null,
      extracted_json: JSON.stringify(opts.extracted),
      extract_engine: opts.engine,
      extract_status: opts.status,
      updated_at: now,
    });
}

function parseExtracted(raw: string | null): CorporateExtractPayload | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as CorporateExtractPayload;
    if (!parsed.concall) parsed.concall = null;
    else {
      const c = parsed.concall as CorporateExtractPayload["concall"] & {
        sentiment?: string | null;
        sentiment_score?: number | null;
        sentiment_why?: string | null;
      };
      if (!c.sentiment && c.tone) c.sentiment = c.tone;
      if (c.sentiment_score == null) c.sentiment_score = null;
      if (c.sentiment_why == null) c.sentiment_why = null;
      parsed.concall = c;
    }
    if (!parsed.extras) {
      parsed.extras = {
        earnings_snip: null,
        order_wins: null,
        credit_rating: null,
        buyback: null,
        clarification: null,
      };
    }
    return parsed;
  } catch {
    return null;
  }
}

function normDin(d: string | null | undefined): string | null {
  if (!d) return null;
  const digits = String(d).replace(/\D/g, "");
  return digits ? digits.padStart(8, "0") : null;
}

/** Person-name normalize for Expected DIN backfill (not company names). */
export function normalizePersonName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(mr|mrs|ms|miss|dr|shri|smt|prof|retd|ret|commander|cmde|lt|col|gen|adv)\b\.?/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function personNameTokens(value: string): string[] {
  return normalizePersonName(value)
    .split(" ")
    .filter((t) => t.length > 1 && !/^(and|of|the)$/.test(t));
}

/** High-confidence person match — last name must agree when both have ≥2 tokens. */
export function personNamesMatch(left: string, right: string): boolean {
  const a = normalizePersonName(left);
  const b = normalizePersonName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = personNameTokens(left);
  const tb = personNameTokens(right);
  if (!ta.length || !tb.length) return false;
  if (ta.length >= 2 && tb.length >= 2) {
    const lastA = ta[ta.length - 1]!;
    const lastB = tb[tb.length - 1]!;
    if (lastA !== lastB) return false;
    // Share first token or initials (k r ashok ↔ k.r. ashok)
    const firstOk =
      ta[0] === tb[0] ||
      ta[0]!.startsWith(tb[0]!) ||
      tb[0]!.startsWith(ta[0]!) ||
      (ta[0]!.length === 1 && tb[0]!.startsWith(ta[0]!)) ||
      (tb[0]!.length === 1 && ta[0]!.startsWith(tb[0]!));
    return firstOk;
  }
  // Single-token vs multi: only if unique token equals last/first of other
  const short = ta.length <= tb.length ? ta : tb;
  const long = ta.length <= tb.length ? tb : ta;
  if (short.length === 1) {
    return long.includes(short[0]!);
  }
  return false;
}

/**
 * When filing text has names but no DIN (common for SBI elections / SME letters),
 * copy DIN from Expected if the person already sits on the known board.
 * Does not invent DINs — only maps to governance.db seats.
 */
export function enrichExtractWithExpected(
  extracted: CorporateExtractPayload,
  expected: CorporateExtractPayload,
): { extracted: CorporateExtractPayload; filled: number } {
  const seats = (expected.directors || []).filter((d) => normDin(d.din));
  if (!seats.length) return { extracted, filled: 0 };

  let filled = 0;
  const nextDirs = (extracted.directors || []).map((d) => {
    if (normDin(d.din) || !(d.name || "").trim()) return d;
    const hits = seats.filter((s) => personNamesMatch(d.name, s.name));
    if (hits.length !== 1) return d;
    filled += 1;
    return {
      ...d,
      din: normDin(hits[0]!.din),
      designation: d.designation || hits[0]!.designation,
      category: d.category || hits[0]!.category,
    };
  });

  const nextKmp = (extracted.kmp || []).map((k) => {
    if (normDin(k.din) || !(k.name || "").trim()) return k;
    const hits = seats.filter((s) => personNamesMatch(k.name, s.name));
    if (hits.length !== 1) return k;
    filled += 1;
    return { ...k, din: normDin(hits[0]!.din) };
  });

  if (!filled) return { extracted, filled: 0 };

  const notes = [
    extracted.notes,
    `Filled ${filled} DIN(s) from Expected by unique name match (filing had no DIN).`,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    extracted: { ...extracted, directors: nextDirs, kmp: nextKmp, notes },
    filled,
  };
}

/** Compare extract vs Expected so the UI can show what to improve. */
export function computeCorporateGap(
  extracted: CorporateExtractPayload | null,
  expected: CorporateExtractPayload,
  documentTitle: string | null,
  extractStatus: string | null,
): CorporateGap {
  const expDins = new Set(
    (expected.directors || [])
      .map((d) => normDin(d.din))
      .filter((d): d is string => !!d),
  );
  const dirs = extracted?.directors || [];
  const kmp = extracted?.kmp || [];
  const gotDins = new Set(
    [...dirs, ...kmp]
      .map((d) => normDin(d.din))
      .filter((d): d is string => !!d),
  );
  let match = 0;
  for (const d of gotDins) if (expDins.has(d)) match += 1;
  const missing = Math.max(0, expDins.size - match);
  const namesNoDin = dirs.filter(
    (d) => (d.name || "").trim() && !normDin(d.din),
  ).length;
  const title = (documentTitle || "").toLowerCase();
  const flags: string[] = [];
  if (
    extractStatus === "empty_extract" ||
    extractStatus === "no_document" ||
    (!dirs.length && !kmp.length)
  ) {
    flags.push("empty");
  }
  if (
    /auditor|compliance report|quarterly compliance/i.test(title) ||
    /stat[_-]?auditor/i.test(extracted?.source_url || "")
  ) {
    flags.push("wrong_doc");
  }
  if (namesNoDin > 0) flags.push("names_no_din");
  if (!dirs.length && kmp.length > 0) flags.push("kmp_only");
  if (match > 0) flags.push("din_ok");
  else if (gotDins.size > 0) flags.push("din_off_board");
  if (match > 0 && missing > 0) flags.push("partial");
  // New appointees not yet on Expected board
  if (
    dirs.some((d) => (d.name || "").trim()) &&
    match === 0 &&
    gotDins.size === 0 &&
    namesNoDin > 0
  ) {
    flags.push("new_or_unmatched");
  }
  if (/din\(s\) from expected/i.test(extracted?.notes || "")) {
    flags.push("din_from_expected");
  }

  let summary = "Not run";
  if (extractStatus === "no_document") summary = "No board PDF found";
  else if (flags.includes("empty") && flags.includes("wrong_doc")) {
    summary = "Wrong filing (auditor/compliance) · empty extract";
  } else if (flags.includes("empty")) summary = "Empty extract";
  else if (flags.includes("wrong_doc")) summary = "Likely wrong doc type";
  else if (flags.includes("kmp_only")) {
    summary = `KMP only · 0/${expDins.size} board DIN`;
  } else if (flags.includes("din_from_expected") && match > 0) {
    summary = `${match} DIN via Expected name map · ${missing} open`;
  } else if (flags.includes("names_no_din") && match === 0) {
    summary = `Name(s) w/o DIN · not on Expected (new appointee?)`;
  } else if (match > 0) {
    summary = `${match} DIN match · ${missing} Expected still open`;
  } else if (gotDins.size > 0) {
    summary = `${gotDins.size} DIN extracted · none in Expected`;
  } else if (extracted) {
    summary = "Extracted · no DIN overlap";
  }

  return {
    match_din: match,
    missing_din: missing,
    names_no_din: namesNoDin,
    flags,
    summary,
  };
}

export type CorporateListFilter =
  | "All"
  | "NSE"
  | "NSE SME"
  | "Holdings"
  | "Gov board";

/** Companies for a market from the main company DB (full universe). */
export function loadMarketCompanyList(
  market: "NSE" | "NSE SME",
): Array<{ ticker: string; name: string; market: string }> {
  const want = market.toUpperCase();
  return loadAllCompanies()
    .filter((c) => (c.market || "").trim().toUpperCase() === want)
    .map((c) => ({
      ticker: c.ticker.toUpperCase(),
      name: c.name || c.ticker,
      market: c.market || market,
    }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** NSE / NSE SME companies missing a DIN board in governance.db (Missing Data gap). */
export function loadGovBoardMissingList(): Array<{
  ticker: string;
  name: string;
  market: string;
}> {
  const din = dinBoardTickerSet();
  const companies = loadAllCompanies();
  return companies
    .filter((c) => {
      const m = (c.market || "").trim().toUpperCase();
      if (m !== "NSE" && m !== "NSE SME") return false;
      return !din.has(c.ticker.toUpperCase());
    })
    .map((c) => ({
      ticker: c.ticker.toUpperCase(),
      name: c.name || c.ticker,
      market: c.market || "NSE",
    }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function corporateListCounts(): Record<CorporateListFilter, number> {
  return {
    All: CORPORATE_DATA_SEED.length,
    NSE: loadMarketCompanyList("NSE").length,
    "NSE SME": loadMarketCompanyList("NSE SME").length,
    Holdings: loadHoldings().length,
    "Gov board": loadGovBoardMissingList().length,
  };
}

function rowFromSource(
  ticker: string,
  market: string,
  nameHint: string | null,
  byTicker: Map<
    string,
    {
      ticker: string;
      market: string;
      document_url: string | null;
      document_title: string | null;
      document_date: string | null;
      concall_url: string | null;
      concall_title: string | null;
      concall_period: string | null;
      concall_date: string | null;
      extracted_json: string | null;
      extract_engine: string | null;
      extract_status: string | null;
      updated_at: string | null;
    }
  >,
): CorporateDataRow {
  const st = byTicker.get(ticker.toUpperCase());
  const name = (nameHint || "").trim() || companyName(ticker);
  const mkt = market || "NSE";
  const extracted = parseExtracted(st?.extracted_json ?? null);
  const expected = expectedFromGovernance(ticker);
  return {
    ticker: ticker.toUpperCase(),
    name,
    market: mkt,
    tv: tradingviewUrl(ticker, mkt),
    document_url: st?.document_url ?? null,
    document_title: st?.document_title ?? null,
    document_date:
      st?.document_date ??
      dateFromNseArchiveUrl(st?.document_url) ??
      null,
    concall_url: st?.concall_url ?? null,
    concall_title: st?.concall_title ?? null,
    concall_period: st?.concall_period ?? null,
    concall_date: st?.concall_date ?? null,
    extracted,
    expected,
    gap: computeCorporateGap(
      extracted,
      expected,
      st?.document_title ?? null,
      st?.extract_status ?? null,
    ),
    extract_engine: st?.extract_engine ?? null,
    extract_status: st?.extract_status ?? null,
    updated_at: st?.updated_at ?? null,
  };
}

export type CorporateDriftEnrichment = {
  sentiment: string | null;
  sentiment_score: number | null;
  sentiment_why: string | null;
  summary: string | null;
  guidance: string | null;
  din_flags: string[];
  din_summary: string | null;
  match_din: number;
  document_url: string | null;
  document_title: string | null;
  concall_url: string | null;
  extract_status: string | null;
  has_extract: boolean;
  keyword: string | null;
};

/** Lightweight corp snapshot for joining onto concall-drift rows. */
export function loadCorporateEnrichmentByTickers(
  tickers: string[],
): Map<string, CorporateDriftEnrichment> {
  const map = new Map<string, CorporateDriftEnrichment>();
  const keys = [
    ...new Set(
      tickers.map((t) => t.trim().toUpperCase()).filter(Boolean),
    ),
  ];
  if (!keys.length) return map;

  const conn = ensureDb();
  const placeholders = keys.map(() => "?").join(",");
  const rows = conn
    .prepare(
      `SELECT ticker, document_url, concall_url, extracted_json,
              extract_status, document_title
       FROM corporate_rows
       WHERE ticker IN (${placeholders})`,
    )
    .all(...keys) as Array<{
    ticker: string;
    document_url: string | null;
    concall_url: string | null;
    extracted_json: string | null;
    extract_status: string | null;
    document_title: string | null;
  }>;

  for (const row of rows) {
    const extracted = parseExtracted(row.extracted_json);
    const expected = expectedFromGovernance(row.ticker);
    const gap = computeCorporateGap(
      extracted,
      expected,
      row.document_title,
      row.extract_status,
    );
    const call = extracted?.concall;
    const keyword = primaryCorporateEventKeyword(
      row.document_title,
      call?.summary,
      call?.guidance,
    );
    map.set(row.ticker.toUpperCase(), {
      sentiment: call?.sentiment ?? null,
      sentiment_score:
        typeof call?.sentiment_score === "number"
          ? call.sentiment_score
          : null,
      sentiment_why: call?.sentiment_why ?? null,
      summary: call?.summary ?? null,
      guidance: call?.guidance ?? null,
      din_flags: gap.flags,
      din_summary: gap.summary || null,
      match_din: gap.match_din,
      document_url: row.document_url,
      document_title: row.document_title,
      concall_url: row.concall_url || call?.url || null,
      extract_status: row.extract_status,
      has_extract: !!extracted,
      keyword,
    });
  }
  return map;
}

export function listCorporateDataRows(
  market: CorporateListFilter = "All",
): CorporateDataRow[] {
  const conn = ensureDb();
  const stored = conn
    .prepare(
      `SELECT ticker, market, document_url, document_title, document_date,
              concall_url, concall_title, concall_period, concall_date,
              extracted_json, extract_engine, extract_status, updated_at
       FROM corporate_rows`,
    )
    .all() as Array<{
    ticker: string;
    market: string;
    document_url: string | null;
    document_title: string | null;
    document_date: string | null;
    concall_url: string | null;
    concall_title: string | null;
    concall_period: string | null;
    concall_date: string | null;
    extracted_json: string | null;
    extract_engine: string | null;
    extract_status: string | null;
    updated_at: string | null;
  }>;
  const byTicker = new Map(stored.map((r) => [r.ticker.toUpperCase(), r]));

  if (market === "Holdings") {
    return loadHoldings().map((h) =>
      rowFromSource(
        h.ticker,
        h.market || "NSE",
        h.name,
        byTicker,
      ),
    );
  }

  if (market === "Gov board") {
    return loadGovBoardMissingList().map((h) =>
      rowFromSource(h.ticker, h.market || "NSE", h.name, byTicker),
    );
  }

  if (market === "NSE" || market === "NSE SME") {
    return loadMarketCompanyList(market).map((h) =>
      rowFromSource(h.ticker, h.market || market, h.name, byTicker),
    );
  }

  const seeds = CORPORATE_DATA_SEED.filter(
    (s) => market === "All" || s.market === market,
  );

  return seeds.map((s) =>
    rowFromSource(s.ticker, s.market, null, byTicker),
  );
}
